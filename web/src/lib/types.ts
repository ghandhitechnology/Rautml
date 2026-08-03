/* Shared types — mirror of server/src/types.ts (CONTRACT.md § Shared TS types).
 * Do not rename or reshape anything in the "contract" section. */

export type Thread = 'main' | 'fork'

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
  createdAt: number
}

export type RunStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped'

export interface Run {
  id: string
  chatId: string
  thread: Thread
  status: RunStatus
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

/** Every event type emitted by the server (CONTRACT.md § SSE events). */
export const CHAT_EVENT_TYPES = [
  'run.status',
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
  /** When the run itself started (run.status → running). */
  startedAt: number
  /** When the first tool.start of this run landed — the anchor for the worked-for summary. */
  firstStepAt?: number
  endedAt?: number
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
