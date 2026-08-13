// Shared server types. Mirrors web/src/lib/types.ts — keep both in sync.
// The block below (Thread, Chat, Message, Run, Asset, ChatEvent, PendingInput)
// matches CONTRACT.md's "Shared TS types" section exactly.

export type Thread = 'main' | 'fork';

export type FollowUpAttachmentKind = 'text' | 'diagram';

/** A user-selected fragment from a rendered asset, attached to a fork message. */
export interface FollowUpAttachment {
  id: string;
  kind: FollowUpAttachmentKind;
  /** Stable human label without brackets, e.g. "diagram 1". */
  label: string;
  /** Short, safe-to-render summary used by attachment tiles. */
  preview: string;
  /** Exact selected text or the selected diagram block's serialized HTML. */
  content: string;
  assetId: string;
  assetTitle: string;
  version: number;
}

export interface Chat {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
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
  attachments?: FollowUpAttachment[];
  /** Local sources uploaded with this message (user role only). */
  sourceIds?: string[];
  createdAt: number;
}

/**
 * A file the user uploaded into the chat. It lives in the chat's local
 * sources permanently: raw bytes + extracted text on disk, semantic-search
 * chunks in the DB, reachable by agents via list/search/read_source tools.
 */
export interface Source {
  id: string;
  chatId: string;
  /** Original filename, e.g. "보고서.hwp". */
  name: string;
  /** Lowercase extension without the dot: pdf|csv|docx|pptx|md|tex|hwp|hwpx. */
  ext: string;
  mime: string;
  /** Raw file size in bytes. */
  size: number;
  /** processing → indexing in progress; ready → searchable; error → extraction failed. */
  status: 'processing' | 'ready' | 'error';
  error?: string;
  /** Length of the extracted text (0 until indexed). */
  textChars: number;
  chunkCount: number;
  createdAt: number;
}

export interface Run {
  id: string;
  chatId: string;
  thread: Thread;
  status: 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped';
  /** OpenRouter model id the run was started with (absent on legacy rows). */
  model?: string;
  /** Exact inference provider selected for this run. Never silently changed. */
  providerId?: string;
  /** Provider reasoning effort the run was started with. */
  effort?: string;
  /** Elaboration level the run was started with (how much terms get explained). */
  elaboration?: ElaborationLevel;
  /**
   * Main-thread turn watermark. Main run: the last main `model_turns.seq`
   * present before this run appended anything. Fork run: the highest main seq
   * its context may include — the last fully generated main state at start.
   */
  contextSeq?: number;
}

/** How much the assistant unpacks domain-specific terms along the way. */
export type ElaborationLevel = 'undergraduate' | 'bachelors' | 'doctor';

/** One selectable model in the composer (GET /api/models). */
export interface ModelInfo {
  /** Stable UI selection id (`providerId:modelId`). */
  id: string;
  /** Model id sent to the provider. */
  modelId: string;
  /** Stable provider registry id. */
  providerId: string;
  name: string;
  /** Compact label for the composer chip, e.g. 'Sol'. */
  shortName: string;
  provider: string;
  description: string;
  /** Provider reasoning-effort wire values, in ascending order. */
  efforts: string[];
  defaultEffort: string;
}

export type ProviderAuthStatus = 'connected' | 'disconnected' | 'unavailable' | 'unknown';

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  cli: string;
  installed: boolean;
  authStatus: ProviderAuthStatus;
  authHint?: string;
  modelCount: number;
  models: ModelInfo[];
}

/** One rolling window from CLIProxyAPI / first-party usage. */
export interface UsageWindow {
  usedPercent: number;
  /** Epoch ms when this window resets; null when the provider did not say. */
  resetAt: number | null;
}

/** Dollar-denominated OpenRouter credit balance or API-key spending allowance. */
export interface ProviderBalance {
  remaining: number;
  used?: number;
  total?: number;
  scope: 'account' | 'key';
}

/** Cached limits and/or balance for one provider. */
export interface ProviderUsage {
  id: string;
  name: string;
  plan?: string;
  accounts: number;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  balance?: ProviderBalance;
  error?: string;
}

/** Last snapshot written by the 10-minute usage poller. */
export interface UsageSnapshot {
  providers: ProviderUsage[];
  updatedAt: number;
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

// --- Settings ---

/** An API key as reported to the renderer: enough to recognise, never the secret. */
export interface ApiKeyStatus {
  name: string;
  label: string;
  hint: string;
  optional: boolean;
  set: boolean;
  /** Last four characters, e.g. `••••4f2a`. Empty when unset. */
  masked: string;
  /** Where the effective value comes from. Saved file values take precedence. */
  source: 'file' | 'environment' | 'unset';
}

export interface Personalization {
  /** Standing design wishes, appended to the asset design constitution. */
  designPreferences: string;
  /** Profession, interests, preferred voice — appended to the system prompt. */
  aboutMe: string;
}

export interface SettingsPayload {
  keys: ApiKeyStatus[];
  personalization: Personalization;
}
