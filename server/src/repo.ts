// All SQL lives here. Typed persistence layer for the API + engine.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { db, SOURCES_DIR, WORKSPACES_DIR } from './db.js';
import type {
  Asset,
  AssetWithVersions,
  Chat,
  ChatEvent,
  ElaborationLevel,
  Message,
  PendingInput,
  Run,
  Source,
  Thread,
} from './types.js';

// ---------------------------------------------------------------------------
// Row -> type mappers
// ---------------------------------------------------------------------------

function rowToChat(row: any): Chat {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function rowToMessage(row: any): Message {
  let attachments: Message['attachments'];
  if (typeof row.attachments === 'string' && row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      /* A corrupt optional payload must not make the conversation unreadable. */
    }
  }
  let sourceIds: string[] | undefined;
  if (typeof row.source_ids === 'string' && row.source_ids) {
    try {
      const parsed = JSON.parse(row.source_ids);
      if (Array.isArray(parsed)) sourceIds = parsed.filter((v) => typeof v === 'string');
    } catch {
      /* A corrupt optional payload must not make the conversation unreadable. */
    }
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    thread: row.thread,
    role: row.role,
    content: row.content,
    status: row.status,
    runId: row.run_id ?? undefined,
    ...(attachments?.length ? { attachments } : {}),
    ...(sourceIds?.length ? { sourceIds } : {}),
    createdAt: row.created_at,
  };
}

function rowToSource(row: any): Source {
  return {
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    status: row.status,
    error: row.error ?? undefined,
    textChars: row.text_chars ?? 0,
    chunkCount: row.chunk_count ?? 0,
    createdAt: row.created_at,
  };
}

function rowToRun(row: any): Run {
  return {
    id: row.id,
    chatId: row.chat_id,
    thread: row.thread,
    status: row.status,
    model: row.model ?? undefined,
    providerId: row.provider ?? undefined,
    effort: row.effort ?? undefined,
    elaboration: row.elaboration ?? undefined,
    contextSeq: typeof row.context_seq === 'number' ? row.context_seq : undefined,
  };
}

function rowToAsset(row: any): Asset {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    title: row.title,
    latestVersion: row.latestVersion ?? 0,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// chats
// ---------------------------------------------------------------------------

export function createChat(): Chat {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    'New chat',
    now,
    now,
  );
  // Workspace = server/data/workspaces/<chatId>/, created on chat creation.
  mkdirSync(path.join(WORKSPACES_DIR, id), { recursive: true });
  return { id, title: 'New chat', createdAt: now, updatedAt: now };
}

export function listChats(): Chat[] {
  const rows = db.prepare(`SELECT * FROM chats ORDER BY updated_at DESC`).all() as any[];
  return rows.map(rowToChat);
}

export function getChat(id: string): Chat | undefined {
  const row = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as any;
  return row ? rowToChat(row) : undefined;
}

export function deleteChat(id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare(
      `DELETE FROM asset_versions WHERE asset_id IN (SELECT id FROM assets WHERE chat_id = ?)`,
    ).run(id);
    db.prepare(`DELETE FROM assets WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM pending_inputs WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM tool_events WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM model_turns WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM runs WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM source_chunks WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM sources WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM chats WHERE id = ?`).run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
  rmSync(path.join(SOURCES_DIR, id), { recursive: true, force: true });
}

export function touchChat(id: string): void {
  db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function setChatTitle(id: string, title: string): void {
  db.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id);
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export function insertMessage(input: {
  chatId: string;
  thread: Thread;
  role: 'user' | 'assistant';
  content: string;
  status?: Message['status'];
  runId?: string;
  id?: string;
  attachments?: Message['attachments'];
  sourceIds?: string[];
}): Message {
  const id = input.id ?? randomUUID();
  const now = Date.now();
  const status = input.status ?? 'complete';
  db.prepare(
    `INSERT INTO messages (id, chat_id, thread, role, content, status, run_id, attachments, source_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.chatId,
    input.thread,
    input.role,
    input.content,
    status,
    input.runId ?? null,
    input.attachments?.length ? JSON.stringify(input.attachments) : null,
    input.sourceIds?.length ? JSON.stringify(input.sourceIds) : null,
    now,
  );
  return {
    id,
    chatId: input.chatId,
    thread: input.thread,
    role: input.role,
    content: input.content,
    status,
    runId: input.runId,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.sourceIds?.length ? { sourceIds: input.sourceIds } : {}),
    createdAt: now,
  };
}

export function updateMessageContent(id: string, content: string): void {
  db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(content, id);
}

export function updateMessageStatus(id: string, status: Message['status']): void {
  db.prepare(`UPDATE messages SET status = ? WHERE id = ?`).run(status, id);
}

export function listMessages(chatId: string, thread: Thread): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE chat_id = ? AND thread = ? ORDER BY created_at ASC, rowid ASC`)
    .all(chatId, thread) as any[];
  return rows.map(rowToMessage);
}

// ---------------------------------------------------------------------------
// model_turns — canonical model-side transcript per thread, for context rebuild
// ---------------------------------------------------------------------------

export function appendModelTurn(chatId: string, thread: Thread, turn: any): void {
  const seqRow = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq FROM model_turns WHERE chat_id = ? AND thread = ?`)
    .get(chatId, thread) as any;
  const seq = seqRow.nextSeq;
  db.prepare(`INSERT INTO model_turns (chat_id, thread, seq, json) VALUES (?, ?, ?, ?)`).run(
    chatId,
    thread,
    seq,
    JSON.stringify(turn),
  );
}

export function listModelTurns(chatId: string, thread: Thread): any[] {
  const rows = db
    .prepare(`SELECT json FROM model_turns WHERE chat_id = ? AND thread = ? ORDER BY seq ASC`)
    .all(chatId, thread) as any[];
  return rows.map((r) => JSON.parse(r.json));
}

/** Turns up to (and including) a watermark seq — a point-in-time transcript. */
export function listModelTurnsUpTo(chatId: string, thread: Thread, maxSeq: number): any[] {
  const rows = db
    .prepare(
      `SELECT json FROM model_turns WHERE chat_id = ? AND thread = ? AND seq <= ? ORDER BY seq ASC`,
    )
    .all(chatId, thread, maxSeq) as any[];
  return rows.map((r) => JSON.parse(r.json));
}

/** The highest turn seq on a thread right now (0 when the thread is empty). */
export function maxModelTurnSeq(chatId: string, thread: Thread): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) as maxSeq FROM model_turns WHERE chat_id = ? AND thread = ?`)
    .get(chatId, thread) as any;
  return row.maxSeq;
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export function createRun(
  chatId: string,
  thread: Thread,
  providerId?: string,
  model?: string,
  effort?: string,
  elaboration?: ElaborationLevel,
  contextSeq?: number,
): Run {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, chat_id, thread, status, error, created_at, finished_at, provider, model, effort, elaboration, context_seq)
     VALUES (?, ?, ?, 'running', NULL, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(id, chatId, thread, now, providerId ?? null, model ?? null, effort ?? null, elaboration ?? null, contextSeq ?? null);
  return { id, chatId, thread, status: 'running', providerId, model, effort, elaboration, contextSeq };
}

export function setRunStatus(runId: string, status: Run['status'], error?: string): void {
  const finishedAt = status === 'done' || status === 'error' || status === 'stopped' ? Date.now() : null;
  db.prepare(`UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(
    status,
    error ?? null,
    finishedAt,
    runId,
  );
}

export function getActiveRun(chatId: string, thread: Thread): Run | undefined {
  const row = db
    .prepare(
      `SELECT * FROM runs WHERE chat_id = ? AND thread = ? AND status IN ('running','awaiting_input')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId, thread) as any;
  return row ? rowToRun(row) : undefined;
}

/** Work that must survive after the last desktop window closes. */
export function hasActiveWork(): boolean {
  const activeRuns = db
    .prepare(`SELECT 1 FROM runs WHERE status IN ('running', 'awaiting_input') LIMIT 1`)
    .get();
  if (activeRuns) return true;
  return !!db.prepare(`SELECT 1 FROM sources WHERE status = 'processing' LIMIT 1`).get();
}

export function getRun(runId: string): Run | undefined {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as any;
  return row ? rowToRun(row) : undefined;
}

// ---------------------------------------------------------------------------
// tool_events / SSE persistence
// ---------------------------------------------------------------------------
// NOTE: tool_events has no `thread` column in CONTRACT.md's DDL, and sse.ts's
// publish(chatId, thread, type, data) has no runId either. We keep the schema
// verbatim and round-trip `thread` through the opaque `payload` blob
// (payload = JSON.stringify({ thread, data })); run_id is stored NULL since
// callers don't supply one. type/seq/created_at remain real columns.

export function nextSeq(chatId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq FROM tool_events WHERE chat_id = ?`)
    .get(chatId) as any;
  return row.nextSeq;
}

export function insertEvent(chatId: string, thread: Thread, type: string, data: any): ChatEvent {
  const seq = nextSeq(chatId);
  const now = Date.now();
  const payload = JSON.stringify({ thread, data });
  db.prepare(
    `INSERT INTO tool_events (chat_id, run_id, seq, type, payload, created_at) VALUES (?, NULL, ?, ?, ?, ?)`,
  ).run(chatId, seq, type, payload, now);
  return { seq, chatId, thread, type, data, at: now };
}

export function listEventsAfter(chatId: string, afterSeq: number): ChatEvent[] {
  const rows = db
    .prepare(`SELECT seq, type, payload, created_at FROM tool_events WHERE chat_id = ? AND seq > ? ORDER BY seq ASC`)
    .all(chatId, afterSeq) as any[];
  return rows.map((row) => {
    const parsed = JSON.parse(row.payload);
    return { seq: row.seq, chatId, thread: parsed.thread as Thread, type: row.type, data: parsed.data, at: row.created_at };
  });
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

const ASSET_SELECT = `SELECT a.*, (SELECT MAX(version) FROM asset_versions WHERE asset_id = a.id) as latestVersion FROM assets a`;

export function createAsset(input: {
  chatId: string;
  messageId: string;
  title: string;
  relPath: string;
  html: string;
}): Asset {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO assets (id, chat_id, message_id, title, rel_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.chatId, input.messageId, input.title, input.relPath, now);
  db.prepare(
    `INSERT INTO asset_versions (id, asset_id, version, html, created_at) VALUES (?, ?, 1, ?, ?)`,
  ).run(randomUUID(), id, input.html, now);
  return {
    id,
    chatId: input.chatId,
    messageId: input.messageId,
    title: input.title,
    latestVersion: 1,
    createdAt: now,
  };
}

export function addAssetVersion(assetId: string, html: string): Asset {
  const asset = getAsset(assetId);
  if (!asset) throw new Error(`asset not found: ${assetId}`);
  const nextVersion = asset.latestVersion + 1;
  const now = Date.now();
  db.prepare(
    `INSERT INTO asset_versions (id, asset_id, version, html, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), assetId, nextVersion, html, now);
  return { ...asset, latestVersion: nextVersion };
}

export function getAsset(assetId: string): Asset | undefined {
  const row = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(assetId) as any;
  return row ? rowToAsset(row) : undefined;
}

export function getAssetVersionHtml(assetId: string, version: number | 'latest'): string | undefined {
  if (version === 'latest') {
    const row = db
      .prepare(`SELECT html FROM asset_versions WHERE asset_id = ? ORDER BY version DESC LIMIT 1`)
      .get(assetId) as any;
    return row?.html;
  }
  const row = db
    .prepare(`SELECT html FROM asset_versions WHERE asset_id = ? AND version = ?`)
    .get(assetId, version) as any;
  return row?.html;
}

export function listAssetsWithLatest(chatId: string): AssetWithVersions[] {
  const rows = db.prepare(`${ASSET_SELECT} WHERE a.chat_id = ? ORDER BY a.created_at ASC`).all(chatId) as any[];
  return rows.map((row) => {
    const asset = rowToAsset(row);
    const versionRows = db
      .prepare(`SELECT version, created_at FROM asset_versions WHERE asset_id = ? ORDER BY version ASC`)
      .all(asset.id) as any[];
    return {
      ...asset,
      versions: versionRows.map((v) => ({ version: v.version, createdAt: v.created_at })),
    };
  });
}

export function findAssetByPath(chatId: string, relPath: string): Asset | undefined {
  const row = db.prepare(`${ASSET_SELECT} WHERE a.chat_id = ? AND a.rel_path = ?`).get(chatId, relPath) as any;
  return row ? rowToAsset(row) : undefined;
}

// ---------------------------------------------------------------------------
// sources — uploaded files + their semantic-search chunks
// ---------------------------------------------------------------------------

export function createSource(input: {
  chatId: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  id?: string;
}): Source {
  const id = input.id ?? randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sources (id, chat_id, name, ext, mime, size, status, error, text_chars, chunk_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', NULL, 0, 0, ?)`,
  ).run(id, input.chatId, input.name, input.ext, input.mime, input.size, now);
  return {
    id,
    chatId: input.chatId,
    name: input.name,
    ext: input.ext,
    mime: input.mime,
    size: input.size,
    status: 'processing',
    textChars: 0,
    chunkCount: 0,
    createdAt: now,
  };
}

export function getSource(id: string): Source | undefined {
  const row = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as any;
  return row ? rowToSource(row) : undefined;
}

export function listSources(chatId: string): Source[] {
  const rows = db
    .prepare(`SELECT * FROM sources WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(chatId) as any[];
  return rows.map(rowToSource);
}

/** Every source still mid-index — re-enqueued on boot so a restart can't strand them. */
export function listProcessingSources(): Source[] {
  const rows = db.prepare(`SELECT * FROM sources WHERE status = 'processing'`).all() as any[];
  return rows.map(rowToSource);
}

export function setSourceError(id: string, error: string): void {
  db.prepare(`UPDATE sources SET status = 'error', error = ? WHERE id = ?`).run(
    error.slice(0, 500),
    id,
  );
}

export function setSourceReady(id: string, textChars: number, chunkCount: number): void {
  db.prepare(
    `UPDATE sources SET status = 'ready', error = NULL, text_chars = ?, chunk_count = ? WHERE id = ?`,
  ).run(textChars, chunkCount, id);
}

export function deleteSource(id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM source_chunks WHERE source_id = ?`).run(id);
    db.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface SourceChunk {
  sourceId: string;
  seq: number;
  startOff: number;
  endOff: number;
  text: string;
  /** Normalized float32 vector bytes; null when indexed without embeddings. */
  embedding: Uint8Array | null;
}

export function replaceSourceChunks(sourceId: string, chatId: string, chunks: SourceChunk[]): void {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM source_chunks WHERE source_id = ?`).run(sourceId);
    const insert = db.prepare(
      `INSERT INTO source_chunks (source_id, chat_id, seq, start_off, end_off, text, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const chunk of chunks) {
      insert.run(sourceId, chatId, chunk.seq, chunk.startOff, chunk.endOff, chunk.text, chunk.embedding);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listChunksForChat(chatId: string): SourceChunk[] {
  const rows = db
    .prepare(
      `SELECT source_id, seq, start_off, end_off, text, embedding FROM source_chunks WHERE chat_id = ? ORDER BY source_id, seq`,
    )
    .all(chatId) as any[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    seq: row.seq,
    startOff: row.start_off,
    endOff: row.end_off,
    text: row.text,
    embedding: row.embedding ?? null,
  }));
}

// ---------------------------------------------------------------------------
// pending_inputs (ask_user_input_v0)
// ---------------------------------------------------------------------------

export function createPendingInput(input: {
  runId: string;
  chatId: string;
  thread: Thread;
  question: string;
  options: string[];
}): PendingInput {
  const id = randomUUID();
  const payload = JSON.stringify({ question: input.question, options: input.options });
  db.prepare(
    `INSERT INTO pending_inputs (id, run_id, chat_id, thread, payload, resolved) VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(id, input.runId, input.chatId, input.thread, payload);
  return { id, question: input.question, options: input.options };
}

export function resolvePendingInput(id: string, value: string): void {
  const row = db.prepare(`SELECT payload FROM pending_inputs WHERE id = ?`).get(id) as any;
  const parsed = row ? JSON.parse(row.payload) : {};
  const payload = JSON.stringify({ ...parsed, value });
  db.prepare(`UPDATE pending_inputs SET payload = ?, resolved = 1 WHERE id = ?`).run(payload, id);
}

export function getUnresolvedInput(chatId: string): PendingInput | undefined {
  const row = db
    .prepare(`SELECT * FROM pending_inputs WHERE chat_id = ? AND resolved = 0 ORDER BY rowid DESC LIMIT 1`)
    .get(chatId) as any;
  if (!row) return undefined;
  const parsed = JSON.parse(row.payload);
  return { id: row.id, question: parsed.question, options: parsed.options };
}
