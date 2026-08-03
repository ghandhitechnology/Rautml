// Every HTTP route from CONTRACT.md § HTTP API, mounted at /api by index.ts.
//
//   GET    /api/chats                     → Chat[] (desc by updated_at)
//   POST   /api/chats                     → Chat
//   DELETE /api/chats/:id                 → { ok: true }
//   GET    /api/chats/:id                 → { chat, messages, assets, events, pendingInput, activeRun }
//   POST   /api/chats/:id/messages        → { runId }   (409 if a run is active on that thread)
//   POST   /api/chats/:id/input           → { runId }   resumes a parked run
//   POST   /api/chats/:id/stop            → { stopped: string[] }
//   GET    /api/chats/:id/events?after=N  → SSE (replay of seq > N, then live)
//   GET    /api/assets/:assetId/:version  → text/html
//
// All persistence goes through repo.ts; all agent work goes through engine.ts;
// all fan-out goes through sse.ts. No SQL and no model calls live here.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { WORKSPACES_DIR } from '../db.js';
import * as engine from '../agent/engine.js';
import * as repo from '../repo.js';
import * as sse from '../sse.js';
import type { Message, Thread } from '../types.js';

const router = Router();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

/** @types/express types params as `string | string[]`; normalise to a string. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function parseThread(value: unknown): Thread | null {
  return value === 'main' || value === 'fork' ? value : null;
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
  res.json({ ok: true });
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
  });
});

// ---------------------------------------------------------------------------
// messages — starts an agentic run
// ---------------------------------------------------------------------------

router.post('/chats/:id/messages', async (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');

  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  if (!content.trim()) return fail(res, 400, 'content must be a non-empty string');

  const thread = parseThread(req.body?.thread);
  if (!thread) return fail(res, 400, "thread must be 'main' or 'fork'");

  const active = repo.getActiveRun(chatId, thread);
  if (active) {
    return res
      .status(409)
      .json({ error: `A run is already active on the ${thread} thread`, runId: active.id });
  }

  try {
    const { runId } = await engine.startRun(chatId, thread, content);
    res.json({ runId });
  } catch (err) {
    console.error('[api] startRun failed', err);
    fail(res, 500, (err as Error)?.message ?? 'Failed to start run');
  }
});

// ---------------------------------------------------------------------------
// input — resumes a run parked on ask_user_input_v0
// ---------------------------------------------------------------------------

router.post('/chats/:id/input', async (req: Request, res: Response) => {
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
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

router.post('/chats/:id/stop', (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  const chat = repo.getChat(chatId);
  if (!chat) return fail(res, 404, 'Chat not found');
  res.json(engine.stopRun(chatId));
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

router.get('/chats/:id/files/*', async (req: Request, res: Response) => {
  const chatId = param(req, 'id');
  if (!repo.getChat(chatId)) return fail(res, 404, 'Chat not found');

  const raw = (req.params as Record<string, string | string[]>)['0'];
  const relPath = decodeURIComponent((Array.isArray(raw) ? raw.join('/') : raw ?? '').toString());
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
});

export default router;
