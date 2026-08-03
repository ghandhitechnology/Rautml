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
  /** OpenRouter model id the run was started with (absent on legacy rows). */
  model?: string;
  /** Provider reasoning effort the run was started with. */
  effort?: string;
  /** Elaboration level the run was started with (how much terms get explained). */
  elaboration?: ElaborationLevel;
}

/** How much the assistant unpacks domain-specific terms along the way. */
export type ElaborationLevel = 'undergraduate' | 'bachelors' | 'doctor';

/** One selectable model in the composer (GET /api/models). */
export interface ModelInfo {
  /** OpenRouter model id, e.g. 'openai/gpt-5.6-sol'. */
  id: string;
  name: string;
  /** Compact label for the composer chip, e.g. 'Sol'. */
  shortName: string;
  provider: string;
  description: string;
  /** Provider reasoning-effort wire values, in ascending order. */
  efforts: string[];
  defaultEffort: string;
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
  /** The tool_call id being executed (set per call by the engine). */
  toolCallId?: string;
  /** Aborted when the run is stopped — long-running tools must honour it. */
  signal?: AbortSignal;
  emit(type: string, data: any): void;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
  execute(args: any, ctx: ToolCtx): Promise<string>;
}
