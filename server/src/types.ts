// Shared server types. Mirrors web/src/lib/types.ts — keep both in sync.
// The block below (Thread, Chat, Message, Run, Asset, ChatEvent, PendingInput)
// matches CONTRACT.md's "Shared TS types" section exactly.

export type Thread = 'main' | 'fork';

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  chatId: string;
  thread: Thread;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete' | 'error';
  runId?: string;
  createdAt: number;
}

export interface Run {
  id: string;
  chatId: string;
  thread: Thread;
  status: 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped';
}

export interface Asset {
  id: string;
  chatId: string;
  messageId: string;
  title: string;
  latestVersion: number;
  createdAt: number;
}

export interface ChatEvent {
  seq: number;
  chatId: string;
  thread: Thread;
  type: string;
  data: any;
  /** Epoch ms when the event was recorded — lets the UI compute real durations after replay. */
  at: number;
}

export interface PendingInput {
  id: string;
  question: string;
  options: string[];
}

// --- Additional types needed to fulfill the HTTP API contract ---
// Not explicitly spelled out in CONTRACT.md's shared-types block, but referenced
// by `GET /api/chats/:id` → `{ ..., assets: AssetWithVersions[], ... }`.

export interface AssetVersionMeta {
  version: number;
  createdAt: number;
}

export interface AssetWithVersions extends Asset {
  versions: AssetVersionMeta[];
}

// --- Tool registry contract ---

export interface ToolCtx {
  chatId: string;
  runId: string;
  thread: Thread;
  workspaceDir: string;
  messageId: string;
  emit(type: string, data: any): void;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
  execute(args: any, ctx: ToolCtx): Promise<string>;
}
