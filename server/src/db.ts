import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, '..', 'data');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const DB_PATH = path.join(DATA_DIR, 'rautml.db');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORKSPACES_DIR, { recursive: true });

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

-- Indices for the access patterns repo.ts needs. Additive only, no schema
-- deviation (all columns above match CONTRACT.md verbatim).
CREATE INDEX IF NOT EXISTS idx_messages_chat_thread ON messages (chat_id, thread, created_at);
CREATE INDEX IF NOT EXISTS idx_model_turns_chat_thread_seq ON model_turns (chat_id, thread, seq);
CREATE INDEX IF NOT EXISTS idx_runs_chat_thread_status ON runs (chat_id, thread, status);
CREATE INDEX IF NOT EXISTS idx_tool_events_chat_seq ON tool_events (chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_assets_chat ON assets (chat_id);
CREATE INDEX IF NOT EXISTS idx_asset_versions_asset_version ON asset_versions (asset_id, version);
CREATE INDEX IF NOT EXISTS idx_pending_inputs_chat_resolved ON pending_inputs (chat_id, resolved);
`);
