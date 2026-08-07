// Every HTTP route from CONTRACT.md § HTTP API, mounted at /api by index.ts.
//
//   GET    /api/health                    → { ok, busy }
//   GET    /api/models?refresh=1          → { models, providers, defaultModelId }
//   POST   /api/providers/:id/reconnect   → launch provider login (loopback only)
//   GET    /api/settings                  → { keys, personalization }          (loopback only)
//   PUT    /api/settings/keys             → { keys }                           (loopback only)
//   PUT    /api/settings/personalization  → { personalization }                (loopback only)
//   GET    /api/chats                     → Chat[] (desc by updated_at)
//   POST   /api/chats                     → Chat
//   DELETE /api/chats/:id                 → { ok: true }
//   GET    /api/chats/:id                 → { chat, messages, assets, events, pendingInput, activeRun, sources }
//   POST   /api/chats/:id/retitle         → { title, changed } using GPT-5.6 Luna
//   POST   /api/chats/:id/sources         → { sources, rejected } (multipart, field name: files)
//   GET    /api/chats/:id/sources         → Source[]
//   GET    /api/sources/:sourceId/file    → the raw uploaded file
//   DELETE /api/sources/:sourceId         → { ok: true }
//   POST   /api/chats/:id/messages        → { runId }   (409 if a run is active on that thread)
//   POST   /api/chats/:id/input           → { runId }   resumes a parked run
//   POST   /api/chats/:id/stop            → { stopped: string[] } (optional body: { thread })
//   GET    /api/chats/:id/events?after=N  → SSE (replay of seq > N, then live)
//   GET    /api/assets/:assetId/:version  → text/html
//   GET    /api/chats/:id/files/*         → download a file from the chat's workspace
//
// All persistence goes through repo.ts; all agent work goes through engine.ts;
// all fan-out goes through sse.ts. No SQL and no model calls live here.
import { mkdirSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { SOURCES_DIR, WORKSPACES_DIR } from '../db.js';
import * as engine from '../agent/engine.js';
import { ProviderUnavailableError } from '../agent/llm.js';
import { resolveSelection } from '../agent/models.js';
import {
  defaultModelId,
  discoverProviders,
  invalidateProviderCache,
  launchReconnect,
} from '../agent/providers.js';
import * as repo from '../repo.js';
import * as settings from '../settings.js';
import * as sse from '../sse.js';
import { extForName, SUPPORTED_EXTS } from '../sources/extract.js';
import { enqueueIndex, rawFilePath, sourceDir } from '../sources/indexer.js';
import type { FollowUpAttachment, Message, Thread } from '../types.js';

const router = Router();

// ---------------------------------------------------------------------------
// uploads — multipart into a per-chat staging dir, then moved per source.
// Per-file cap 400MB; no limit on the number of files per request or per chat.
// ---------------------------------------------------------------------------

export const SOURCE_FILE_SIZE_LIMIT = 400 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(SOURCES_DIR, param(req as Request, 'id'), '.incoming');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { fileSize: SOURCE_FILE_SIZE_LIMIT },
});

/** Multer decodes filenames as latin1; Korean names need the round-trip. */
function decodeOriginalName(name: string): string {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

/**
 * Safety net for async route handlers and callbacks: a rejection becomes a
 * 500 JSON without internals instead of an unhandled rejection that would
 * crash the engine process.
 */
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => {
      console.error(`[api] ${req.method} ${req.originalUrl} failed`, err);
      if (!res.headersSent) fail(res, 500, 'Internal server error');
    });
  };
}

/** @types/express types params as `string | string[]`; normalise to a string. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Gate for routes that touch this machine's own configuration or shell. */
function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');
}

function parseThread(value: unknown): Thread | null {
  return value === 'main' || value === 'fork' ? value : null;
}

function parseAttachments(value: unknown): FollowUpAttachment[] | string {
  if (value == null) return [];
  if (!Array.isArray(value)) return 'attachments must be an array';
  if (value.length > 6) return 'attachments can contain at most 6 selections';

  const attachments: FollowUpAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return 'each attachment must be an object';
    const item = raw as Record<string, unknown>;
    const kind = item.kind === 'text' || item.kind === 'diagram' ? item.kind : null;
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 120) : '';
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, 40) : '';
    const preview = typeof item.preview === 'string' ? item.preview.trim().slice(0, 240) : '';
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 10_000) : '';
    const assetId = typeof item.assetId === 'string' ? item.assetId.trim().slice(0, 120) : '';
    const assetTitle =
      typeof item.assetTitle === 'string' ? item.assetTitle.trim().slice(0, 160) : '';
    const version = Number(item.version);
    if (!kind || !id || !label || !content || !assetId || !Number.isInteger(version) || version < 1) {
      return 'attachment fields are invalid';
    }
    attachments.push({
      id,
      kind,
      label,
      preview: preview || (kind === 'diagram' ? 'Selected diagram' : content.slice(0, 180)),
      content,
      assetId,
      assetTitle: assetTitle || 'Untitled asset',
      version,
    });
  }
  return attachments;
}

/** Messages for both threads in one list; the client splits them by `thread`. */
function allMessages(chatId: string): Message[] {
  return [...repo.listMessages(chatId, 'main'), ...repo.listMessages(chatId, 'fork')].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}

// ---------------------------------------------------------------------------
// health (not in the contract; harmless and handy for smoke tests)
// ---------------------------------------------------------------------------

router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, busy: repo.hasActiveWork() });
});

// ---------------------------------------------------------------------------
// models — the selectable catalog (ids, labels, per-provider effort levels)
// ---------------------------------------------------------------------------

router.get(
  '/models',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const refresh = req.query.refresh === '1';
      const providers = await discoverProviders(refresh);
      res.json({ models: providers.flatMap((p) => p.models), providers, defaultModelId: await defaultModelId() });
    } catch (err) {
      fail(res, 500, (err as Error)?.message ?? 'Provider discovery failed');
    }
  }),
);

router.post(
  '/providers/:id/reconnect',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isLoopback(req)) {
      return fail(res, 403, 'Provider login can only be launched from this computer');
    }
    res.json(await launchReconnect(param(req, 'id')));
  }),
);

// ---------------------------------------------------------------------------
// settings — API keys (.env) + personalization (settings table)
//
// Loopback-gated like provider login: these read and write this machine's
// configuration, so they must not be reachable from another host even if the
// server is ever bound more widely.
// ---------------------------------------------------------------------------

router.get('/settings', (req: Request, res: Response) => {
  if (!isLoopback(req)) return fail(res, 403, 'Settings are only readable from this computer');
  res.json({ keys: settings.readKeys(), personalization: settings.readPersonalization() });
});

router.put(
  '/settings/keys',
  asyncHandler(async (req: Request, res: Response) => {
    if (!isLoopback(req)) return fail(res, 403, 'Settings are only writable from this computer');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'Expected an object of key/value pairs');
    }
    try {
      const keys = await settings.writeKeys(body as Record<string, string>);
      // A new OpenRouter key changes that provider's auth status; drop the 30s
      // discovery cache so the next /models reflects it immediately.
      invalidateProviderCache();
      res.json({ keys });
    } catch (err) {
      fail(res, 500, (err as Error)?.message ?? 'Could not save API keys');
    }
  }),
);

router.put('/settings/personalization', (req: Request, res: Response) => {
  if (!isLoopback(req)) return fail(res, 403, 'Settings are only writable from this computer');
  const body = req.body ?? {};
  const patch: Record<string, string> = {};
  if (typeof body.designPreferences === 'string') patch.designPreferences = body.designPreferences;
  if (typeof body.aboutMe === 'string') patch.aboutMe = body.aboutMe;
  res.json({ personalization: settings.writePersonalization(patch) });
});

// ---------------------------------------------------------------------------
// chats
// ---------------------------------------------------------------------------

router.get('/chats', (_req: Request, res: Response) => {
  res.json(repo.listChats());
});

router.post('/chats', (_req: Request, res: Response) => {
  res.json(repo.createChat());
});

router.delete('/chats/:id', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');
  // Abort anything in flight before the rows disappear underneath it.
  try {
    engine.stopRun(chatId);
  } catch {
    /* best effort — deletion proceeds regardless */
  }
  repo.deleteChat(chatId);
  res.json({ ok: true });
});

router.get('/chats/:id', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');

  const activeRun = repo.getActiveRun(chatId, 'main') ?? repo.getActiveRun(chatId, 'fork') ?? null;

  res.json({
    chat,
    messages: allMessages(chatId),
    assets: repo.listAssetsWithLatest(chatId),
    events: repo.listEventsAfter(chatId, 0),
    pendingInput: repo.getUnresolvedInput(chatId) ?? null,
    activeRun,
    sources: repo.listSources(chatId),
  });
});

// ---------------------------------------------------------------------------
// sources — uploaded files persisted into the chat's local sources area
// ---------------------------------------------------------------------------

router.post('/chats/:id/sources', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');

  upload.array('files')(req, res, (err: unknown) => {
    if (err) {
      const message =
        (err as { code?: string })?.code === 'LIMIT_FILE_SIZE'
          ? 'A file exceeds the 400MB upload limit'
          : ((err as Error)?.message ?? 'Upload failed');
      return fail(res, 400, message);
    }

    // The staging→final moves below are async; route any failure through the
    // same net as the async route handlers so a rejection can't crash us.
    asyncHandler(async () => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) return fail(res, 400, 'No files in the request (field name: files)');

      const sources = [];
      const rejected: { name: string; error: string }[] = [];
      for (const file of files) {
        const name = decodeOriginalName(file.originalname);
        const ext = extForName(name);
        if (!ext) {
          rejected.push({
            name,
            error: `Unsupported type — allowed: ${SUPPORTED_EXTS.map((e) => `.${e}`).join(', ')}`,
          });
          await fs.rm(file.path, { force: true });
          continue;
        }
        const source = repo.createSource({ chatId, name, ext, mime: file.mimetype, size: file.size });
        await fs.mkdir(sourceDir(chatId, source.id), { recursive: true });
        await fs.rename(file.path, rawFilePath(source));
        sse.publish(chatId, 'main', 'source.added', { source });
        enqueueIndex(source.id);
        sources.push(source);
      }
      repo.touchChat(chatId);
      res.json({ sources, rejected });
    })(req, res);
  });
});

router.get('/chats/:id/sources', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  if (!repo.getChat(chatId)) return fail(res, 404, 'Chat not found');
  res.json(repo.listSources(chatId));
});

router.get('/sources/:sourceId/file', (req: Request, res: Response) => {
  const source = repo.getSource(param(req, 'sourceId'));
  if (!source) return fail(res, 404, 'Source not found');
  res.setHeader('Cache-Control', 'no-store');
  res.download(rawFilePath(source), source.name);
});

router.delete(
  '/sources/:sourceId',
  asyncHandler(async (req: Request, res: Response) => {
    const source = repo.getSource(param(req, 'sourceId'));
    if (!source) return fail(res, 404, 'Source not found');
    repo.deleteSource(source.id);
    await fs.rm(sourceDir(source.chatId, source.id), { recursive: true, force: true });
    sse.publish(source.chatId, 'main', 'source.removed', { sourceId: source.id });
    res.json({ ok: true });
  }),
);

router.post(
  '/chats/:id/retitle',
  asyncHandler(async (req: Request, res: Response) => {
    const chatId = param(req, 'id');
    const chat = repo.getChat(chatId);
    if (!chat) return fail(res, 404, 'Chat not found');

    try {
      const result = await engine.retitleChat(chatId);
      res.json(result ?? { title: chat.title, changed: false });
    } catch (err) {
      // No connected provider right now — a nicer title is optional, so keep
      // the current one instead of failing with a 500 the user can't act on.
      if (err instanceof ProviderUnavailableError) {
        return res.json({ title: chat.title, changed: false });
      }
      console.error('[api] retitleChat failed', err);
      fail(res, 500, (err as Error)?.message ?? 'Failed to refresh chat title');
    }
  }),
);

// ---------------------------------------------------------------------------
// messages — starts an agentic run
// ---------------------------------------------------------------------------

/** Hard cap on a single user message; pastes longer than this are rejected. */
const MAX_MESSAGE_CHARS = 100_000;

router.post(
  '/chats/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const chatId = param(req, 'id');
    const chat = repo.getChat(chatId);
    if (!chat) return fail(res, 404, 'Chat not found');

    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) return fail(res, 400, 'content must be a non-empty string');
    if (content.length > MAX_MESSAGE_CHARS) {
      return fail(res, 400, `content exceeds the ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} character limit`);
    }

    const thread = parseThread(req.body?.thread);
    if (!thread) return fail(res, 400, "thread must be 'main' or 'fork'");

    const attachments = parseAttachments(req.body?.attachments);
    if (typeof attachments === 'string') return fail(res, 400, attachments);
    if (thread !== 'fork' && attachments.length) {
      return fail(res, 400, 'context attachments are only supported on the fork thread');
    }

    // Local sources uploaded with this message — each must belong to this chat.
    const rawSourceIds = req.body?.sourceIds;
    if (rawSourceIds != null && !Array.isArray(rawSourceIds)) {
      return fail(res, 400, 'sourceIds must be an array of strings');
    }
    const sourceIds: string[] = [];
    for (const raw of (rawSourceIds as unknown[]) ?? []) {
      if (typeof raw !== 'string') return fail(res, 400, 'sourceIds must be an array of strings');
      const source = repo.getSource(raw);
      if (!source || source.chatId !== chatId) {
        return fail(res, 400, `Unknown source: ${raw}`);
      }
      sourceIds.push(raw);
    }

    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    const effort = typeof req.body?.effort === 'string' ? req.body.effort : undefined;
    const elaboration =
      typeof req.body?.elaboration === 'string' ? req.body.elaboration : undefined;
    const selection = await resolveSelection(model, effort, elaboration);
    if (typeof selection === 'string') return fail(res, 400, selection);

    const active = repo.getActiveRun(chatId, thread);
    if (active) {
      return res
        .status(409)
        .json({ error: `A run is already active on the ${thread} thread`, runId: active.id });
    }

    try {
      const { runId } = await engine.startRun(
        chatId,
        thread,
        content,
        { model: selection.selectionId, effort: selection.effort, elaboration: selection.elaboration },
        attachments,
        sourceIds,
      );
      res.json({ runId });
    } catch (err) {
      // Two racing requests can both pass the fast-path 409 above; the loser's
      // startRun throws RunConflictError. Answer it with the same 409.
      if (err instanceof engine.RunConflictError) {
        return fail(res, 409, err.message || `A run is already active on the ${thread} thread`);
      }
      console.error('[api] startRun failed', err);
      fail(res, 500, (err as Error)?.message ?? 'Failed to start run');
    }
  }),
);

// ---------------------------------------------------------------------------
// input — resumes a run parked on ask_user_input_v0
// ---------------------------------------------------------------------------

router.post(
  '/chats/:id/input',
  asyncHandler(async (req: Request, res: Response) => {
    const chatId = param(req, 'id');
    const chat = repo.getChat(chatId);
    if (!chat) return fail(res, 404, 'Chat not found');

    const pendingInputId =
      typeof req.body?.pendingInputId === 'string' ? req.body.pendingInputId : '';
    if (!pendingInputId) return fail(res, 400, 'pendingInputId must be a string');

    const value = typeof req.body?.value === 'string' ? req.body.value : '';
    if (!value) return fail(res, 400, 'value must be a non-empty string');

    try {
      const result = await engine.resumeRun(pendingInputId, value);
      if (!result) return fail(res, 409, 'That question is no longer awaiting an answer');
      res.json({ runId: result.runId });
    } catch (err) {
      console.error('[api] resumeRun failed', err);
      fail(res, 500, (err as Error)?.message ?? 'Failed to resume run');
    }
  }),
);

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

router.post('/chats/:id/stop', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');

  // Optional thread scope; omitted means "stop every live run of this chat".
  const rawThread: unknown = req.body?.thread;
  const thread = rawThread == null ? undefined : parseThread(rawThread);
  if (thread === null) return fail(res, 400, "thread must be 'main' or 'fork'");

  res.json(engine.stopRun(chatId, thread));
});

// ---------------------------------------------------------------------------
// events — SSE: replay persisted events with seq > after, then attach live
// ---------------------------------------------------------------------------

router.get('/chats/:id/events', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');

  const rawAfter = req.query.after;
  const parsed = Number.parseInt(typeof rawAfter === 'string' ? rawAfter : '', 10);
  const after = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  // Read the backlog, register, then flush — all synchronous, so no event
  // published by a run in this process can slip into the gap.
  const backlog = repo.listEventsAfter(chatId, after);
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  sse.subscribe(chatId, res);
  for (const event of backlog) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
});

// ---------------------------------------------------------------------------
// assets — the stored html for a version ('latest' allowed)
// ---------------------------------------------------------------------------

router.get('/assets/:assetId/:version', (req: Request, res: Response) => {
  const assetId = param(req, 'assetId');
  const rawVersion = param(req, 'version');

  const asset = repo.getAsset(assetId);
  if (!asset) return fail(res, 404, 'Asset not found');

  let version: number | 'latest';
  if (rawVersion === 'latest') {
    version = 'latest';
  } else {
    const n = Number.parseInt(rawVersion, 10);
    if (!Number.isFinite(n) || n < 1) return fail(res, 400, 'version must be a positive integer or "latest"');
    version = n;
  }

  const html = repo.getAssetVersionHtml(assetId, version);
  if (html == null) return fail(res, 404, 'Asset version not found');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// ---------------------------------------------------------------------------
// workspace files — downloads for present_files cards
// ---------------------------------------------------------------------------

router.get(
  '/chats/:id/files/*',
  asyncHandler(async (req: Request, res: Response) => {
    const chatId = param(req, 'id');
    if (!repo.getChat(chatId)) return fail(res, 404, 'Chat not found');

    const raw = (req.params as Record<string, string | string[]>)['0'];
    let relPath: string;
    try {
      relPath = decodeURIComponent((Array.isArray(raw) ? raw.join('/') : raw ?? '').toString());
    } catch {
      return fail(res, 400, 'Malformed percent-encoding in path');
    }
    const workspaceDir = path.join(WORKSPACES_DIR, chatId);
    const abs = path.resolve(workspaceDir, relPath);
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
      return fail(res, 400, 'Invalid path');
    }

    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return fail(res, 404, 'Not a file');
      res.setHeader('Cache-Control', 'no-store');
      res.download(abs, path.basename(abs));
    } catch {
      fail(res, 404, 'File not found');
    }
  }),
);

export default router;
