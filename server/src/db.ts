import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Desktop builds live inside a read-only app bundle. Electron points this at
// Application Support so chats, generated assets, and source files stay durable.
export const DATA_DIR = process.env.RAUTML_DATA_DIR
  ? path.resolve(process.env.RAUTML_DATA_DIR)
  : path.join(__dirname, '..', 'data');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const SOURCES_DIR = path.join(DATA_DIR, 'sources');
export const DB_PATH = path.join(DATA_DIR, 'rautml.db');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORKSPACES_DIR, { recursive: true });
mkdirSync(SOURCES_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');

// Full schema DDL per CONTRACT.md — idempotent (CREATE TABLE/INDEX IF NOT EXISTS)
// so this can safely run on every boot.
db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  thread TEXT,
  role TEXT,
  content TEXT,
  status TEXT DEFAULT 'complete',
  run_id TEXT,
  attachments TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS model_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  thread TEXT,
  seq INTEGER,
  json TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  thread TEXT,
  status TEXT,
  error TEXT,
  created_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  run_id TEXT,
  seq INTEGER,
  type TEXT,
  payload TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  message_id TEXT,
  title TEXT,
  rel_path TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT,
  version INTEGER,
  html TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pending_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  chat_id TEXT,
  thread TEXT,
  payload TEXT,
  resolved INTEGER DEFAULT 0
);

-- Local sources: files the user uploaded into the chat. The raw file and its
-- extracted text live under data/sources/<chatId>/<sourceId>/; the DB holds
-- metadata plus the semantic-search chunks.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  name TEXT,
  ext TEXT,
  mime TEXT,
  size INTEGER,
  status TEXT DEFAULT 'processing',  -- 'processing'|'ready'|'error'
  error TEXT,
  text_chars INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER
);

-- embedding: Float32Array bytes (normalized), NULL when the local embedding
-- model was unavailable at index time (lexical fallback still works).
CREATE TABLE IF NOT EXISTS source_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  chat_id TEXT,
  seq INTEGER,
  start_off INTEGER,
  end_off INTEGER,
  text TEXT,
  embedding BLOB
);

-- Indices for the access patterns repo.ts needs. Additive only, no schema
-- deviation (all columns above match CONTRACT.md verbatim).
CREATE INDEX IF NOT EXISTS idx_messages_chat_thread ON messages (chat_id, thread, created_at);
CREATE INDEX IF NOT EXISTS idx_model_turns_chat_thread_seq ON model_turns (chat_id, thread, seq);
CREATE INDEX IF NOT EXISTS idx_runs_chat_thread_status ON runs (chat_id, thread, status);
CREATE INDEX IF NOT EXISTS idx_tool_events_chat_seq ON tool_events (chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_assets_chat ON assets (chat_id);
CREATE INDEX IF NOT EXISTS idx_asset_versions_asset_version ON asset_versions (asset_id, version);
CREATE INDEX IF NOT EXISTS idx_pending_inputs_chat_resolved ON pending_inputs (chat_id, resolved);
-- User-global preferences (personalization). API keys are NOT here: they live
-- in the .env file the process boots from, which is already the config source
-- of truth. See settings.ts.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sources_chat ON sources (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunks (source_id, seq);
CREATE INDEX IF NOT EXISTS idx_source_chunks_chat ON source_chunks (chat_id);
`);

// Migration: runs remember which model + reasoning effort + elaboration level
// they were started with, so a parked run resumes on the same settings after a
// server restart.
{
  const runCols = (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!runCols.includes('model')) db.exec(`ALTER TABLE runs ADD COLUMN model TEXT`);
  if (!runCols.includes('provider')) db.exec(`ALTER TABLE runs ADD COLUMN provider TEXT`);
  if (!runCols.includes('effort')) db.exec(`ALTER TABLE runs ADD COLUMN effort TEXT`);
  if (!runCols.includes('elaboration')) db.exec(`ALTER TABLE runs ADD COLUMN elaboration TEXT`);
  // Main-thread turn watermark: for a main run, the last main turn seq that
  // existed before the run appended anything; for a fork run, the main seq it
  // is allowed to read. Lets forks build context from the last *completed*
  // main state instead of a mid-generation transcript.
  if (!runCols.includes('context_seq')) db.exec(`ALTER TABLE runs ADD COLUMN context_seq INTEGER`);
}

// Migration: structured follow-up context is stored with the visible user
// message while the canonical model turn receives a context-enriched prompt.
{
  const messageCols = (db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!messageCols.includes('attachments')) {
    db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
  }
  // Uploaded files sent with a message — JSON array of source ids, so the
  // thread can render file chips on the user bubble.
  if (!messageCols.includes('source_ids')) {
    db.exec(`ALTER TABLE messages ADD COLUMN source_ids TEXT`);
  }
}
