/* Shared types — mirror of server/src/types.ts (CONTRACT.md § Shared TS types).
 * Do not rename or reshape anything in the "contract" section. */

export type Thread = 'main' | 'fork'

export type FollowUpAttachmentKind = 'text' | 'diagram'

/** A user-selected fragment from a rendered asset, attached to a fork message. */
export interface FollowUpAttachment {
  id: string
  kind: FollowUpAttachmentKind
  /** Stable human label without brackets, e.g. "diagram 1". */
  label: string
  /** Short, safe-to-render summary used by attachment tiles. */
  preview: string
  /** Exact selected text or the selected diagram block's serialized HTML. */
  content: string
  assetId: string
  assetTitle: string
  version: number
}

export interface Chat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  chatId: string
  thread: Thread
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'complete' | 'error'
  runId?: string
  attachments?: FollowUpAttachment[]
  /** Local sources uploaded with this message (user role only). */
  sourceIds?: string[]
  createdAt: number
}

/**
 * A file the user uploaded into the chat. Stored permanently in the chat's
 * local sources; agents reach it via list/search/read_source tools.
 */
export interface Source {
  id: string
  chatId: string
  /** Original filename, e.g. "보고서.hwp". */
  name: string
  /** Lowercase extension without the dot: pdf|csv|docx|pptx|md|tex|hwp|hwpx. */
  ext: string
  mime: string
  /** Raw file size in bytes. */
  size: number
  /** processing → indexing in progress; ready → searchable; error → extraction failed. */
  status: 'processing' | 'ready' | 'error'
  error?: string
  /** Length of the extracted text (0 until indexed). */
  textChars: number
  chunkCount: number
  createdAt: number
}

export type RunStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped'

export interface Run {
  id: string
  chatId: string
  thread: Thread
  status: RunStatus
  /** OpenRouter model id the run was started with (absent on legacy rows). */
  model?: string
  /** Provider reasoning effort the run was started with. */
  effort?: string
  /** Elaboration level the run was started with (how much terms get explained). */
  elaboration?: ElaborationLevel
}

/** How much the assistant unpacks domain-specific terms along the way. */
export type ElaborationLevel = 'undergraduate' | 'bachelors' | 'doctor'

/** One selectable model in the composer (GET /api/models). */
export interface ModelInfo {
  /** OpenRouter model id, e.g. 'openai/gpt-5.6-sol'. */
  id: string
  name: string
  /** Compact label for the composer chip, e.g. 'Sol'. */
  shortName: string
  provider: string
  description: string
  /** Provider reasoning-effort wire values, in ascending order. */
  efforts: string[]
  defaultEffort: string
}

export interface Asset {
  id: string
  chatId: string
  messageId: string
  title: string
  latestVersion: number
  createdAt: number
}

export interface ChatEvent {
  seq: number
  chatId: string
  thread: Thread
  type: string
  data: any
  /** Epoch ms when the event was recorded — lets the UI compute real durations after replay. */
  at: number
}

export interface PendingInput {
  id: string
  question: string
  options: string[]
}

/* ------------------------------------------------------------------ extras */

/** Asset as returned by GET /api/chats/:id (version list is advisory). */
export interface AssetWithVersions extends Asset {
  versions?: { version: number; createdAt: number }[]
}

/** Payload of GET /api/chats/:id */
export interface ChatSnapshot {
  chat: Chat
  messages: Message[]
  assets: AssetWithVersions[]
  events: ChatEvent[]
  pendingInput: PendingInput | null
  activeRun: Run | null
  sources?: Source[]
}

export interface PresentedFile {
  name: string
  relPath: string
  size: number
}

/* ------------------------------------------------- SSE event data payloads */

export interface RunStatusEvent {
  runId: string
  status: RunStatus
}
/**
 * What the run is doing between visible events. Emitted from the moment the
 * request leaves, so a long reasoning stretch is never silent.
 */
export type RunPhase = 'connecting' | 'thinking' | 'responding' | 'tools'
export interface RunPhaseEvent {
  runId: string
  phase: RunPhase
  /** Human line for the timeline header, e.g. a clipped reasoning summary. */
  label: string
}
export interface MessageStartEvent {
  messageId: string
  role: 'user' | 'assistant'
}
export interface MessageDeltaEvent {
  messageId: string
  text: string
}
export interface MessageCompleteEvent {
  messageId: string
  content: string
}
export interface ToolStartEvent {
  toolCallId: string
  name: string
  label: string
}
export interface ToolEndEvent {
  toolCallId: string
  name: string
  ok: boolean
  summary: string
}
export interface AssetCreatedEvent {
  asset: Asset
  version: number
}
export interface AssetVersionEvent {
  assetId: string
  version: number
}
export interface WidgetEvent {
  messageId: string
  html: string
}
export interface FilesPresentedEvent {
  messageId: string
  files: PresentedFile[]
}
export interface InputRequestEvent {
  pendingInputId: string
  question: string
  options: string[]
}
export interface InputResolvedEvent {
  pendingInputId: string
  value: string
}
export interface ChatTitleEvent {
  title: string
}
export interface SourceAddedEvent {
  source: Source
}
export interface SourceUpdatedEvent {
  source: Source
}
export interface SourceRemovedEvent {
  sourceId: string
}
export interface SubagentStartEvent {
  subagentId: string
  /** The spawn_subagents tool call this subagent belongs to. */
  parentToolCallId: string
  title: string
  model: string
}
export interface SubagentDeltaEvent {
  subagentId: string
  text: string
}
export interface SubagentToolStartEvent {
  subagentId: string
  toolCallId: string
  name: string
  label: string
}
export interface SubagentToolEndEvent {
  subagentId: string
  toolCallId: string
  name: string
  ok: boolean
  summary: string
}
export interface SubagentEndEvent {
  subagentId: string
  ok: boolean
  summary: string
}
export interface ThinkingStartEvent {
  thinkingId: string
}
export interface ThinkingDeltaEvent {
  thinkingId: string
  /** Reasoning trace chunk — only trace-capable models emit these. */
  text: string
}
export interface ThinkingEndEvent {
  thinkingId: string
  /** Total pause in ms, authoritative. */
  ms: number
}

/** Every event type emitted by the server (CONTRACT.md § SSE events). */
export const CHAT_EVENT_TYPES = [
  'run.status',
  'run.phase',
  'message.start',
  'message.delta',
  'message.complete',
  'tool.start',
  'tool.end',
  'asset.created',
  'asset.version',
  'widget',
  'files.presented',
  'input.request',
  'input.resolved',
  'chat.title',
  'source.added',
  'source.updated',
  'source.removed',
  'subagent.start',
  'subagent.delta',
  'subagent.tool.start',
  'subagent.tool.end',
  'subagent.end',
  'thinking.start',
  'thinking.delta',
  'thinking.end',
] as const

export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number]

/* ---------------------------------------------------------- view-model bits */

/** One tool call rendered in the ActivityTimeline. */
export interface TimelineItem {
  toolCallId: string
  name: string
  label: string
  status: 'running' | 'ok' | 'error'
  summary?: string
  startedAt: number
  endedAt?: number
  /** Row flavor — absent means 'tool'. Thinking rows use toolCallId = thinkingId. */
  kind?: 'tool' | 'thinking'
  /** Accumulated reasoning text (thinking items only). */
  trace?: string
  /** Finalized pause duration in ms (thinking items only). */
  ms?: number
}

/** One research subagent spawned by a spawn_subagents call, with its own stream and tools. */
export interface SubagentRun {
  subagentId: string
  /** The spawn_subagents tool call it belongs to (positions the group in the timeline). */
  parentToolCallId: string
  title: string
  model: string
  status: 'running' | 'ok' | 'error'
  /** Final one-line result ("6 steps · 2,140 chars" / error text). */
  summary?: string
  /** The subagent's own streamed text, rebuilt from subagent.delta events. */
  text: string
  /** The subagent's own tool calls. */
  items: TimelineItem[]
  startedAt: number
  endedAt?: number
}

/** Everything the timeline needs for a single run, keyed by runId in the store.
 *
 * All three timestamps come from `ChatEvent.at` (epoch ms recorded server-side), so a
 * reloaded chat reports the same "Worked for 42s" it did while it was live. */
export interface RunTimeline {
  runId: string
  thread: Thread
  status: RunStatus
  items: TimelineItem[]
  /** Research subagents spawned during this run (absent until the first one starts). */
  subagents?: SubagentRun[]
  /** When the run itself started (run.status → running). */
  startedAt: number
  /** When the first tool.start of this run landed — the anchor for the worked-for summary. */
  firstStepAt?: number
  endedAt?: number
  /** What the run is doing right now. Cleared when the run reaches a terminal status. */
  phase?: RunPhase
  /** Header line for the current phase (reasoning summary while thinking). */
  phaseLabel?: string
}

/** An ask_user_input_v0 request, positioned in the thread it belongs to. */
export interface InputRequest {
  id: string
  chatId: string
  thread: Thread
  runId?: string
  question: string
  options: string[]
  value?: string
  resolved: boolean
  createdAt: number
}

export type ThemeName = 'light' | 'dark'
