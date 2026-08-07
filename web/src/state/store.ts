/* Rautml store (zustand).
 *
 * One store for the whole app: the chat list, the open chat's full state (both threads),
 * live run timelines keyed by runId, assets, pending input, plus UI bits (theme, fork panel).
 * `applyEvent` is the single reducer for every SSE event type in CONTRACT.md.
 */

import { useMemo } from 'react'
import { create } from 'zustand'
import * as api from '../lib/api'
import { connectChatEvents, type SseConnection, type SseStatus } from '../lib/sse'
import { uid } from '../lib/utils'
import { removeFrameContext, type QuestionedMark } from '../lib/frameContext'
import type {
  ApiKeyStatus,
  Asset,
  AssetCreatedEvent,
  ElaborationLevel,
  AssetVersionEvent,
  Chat,
  ChatEvent,
  ChatSnapshot,
  ChatTitleEvent,
  FilesPresentedEvent,
  FollowUpAttachment,
  InputRequest,
  InputRequestEvent,
  InputResolvedEvent,
  Message,
  MessageCompleteEvent,
  MessageDeltaEvent,
  MessageStartEvent,
  ModelInfo,
  Personalization,
  ProviderInfo,
  ProviderErrorEvent,
  PendingInput,
  SettingsSection,
  PresentedFile,
  Run,
  RunPhaseEvent,
  RunStatusEvent,
  RunTimeline,
  Source,
  SourceAddedEvent,
  SourceRemovedEvent,
  SourceUpdatedEvent,
  SubagentDeltaEvent,
  SubagentEndEvent,
  SubagentRun,
  SubagentStartEvent,
  SubagentToolEndEvent,
  SubagentToolStartEvent,
  ThemeName,
  ThinkingDeltaEvent,
  ThinkingEndEvent,
  ThinkingStartEvent,
  Thread,
  TimelineItem,
  ToolEndEvent,
  ToolStartEvent,
  WidgetEvent,
} from '../lib/types'

/* ------------------------------------------------------------------ shapes */

export interface ChatState {
  chat: Chat
  /** Messages per thread, in arrival order. */
  messages: Record<Thread, Message[]>
  /** Activity timeline per run. */
  timelines: Record<string, RunTimeline>
  runOrder: string[]
  /** Most recent runId seen per thread (used to attach tool events). */
  currentRunId: Record<Thread, string | null>
  activeRun: Record<Thread, Run | null>
  assets: Asset[]
  /** assetIds attached to a given assistant messageId. */
  assetsByMessage: Record<string, string[]>
  /** visualize_show_widget html, per messageId. */
  widgets: Record<string, string[]>
  /** present_files cards, per messageId. */
  files: Record<string, PresentedFile[]>
  /** Local sources: every file uploaded into this chat, oldest first. */
  sources: Source[]
  inputRequests: Record<Thread, InputRequest[]>
  pendingInput: PendingInput | null
  lastSeq: number
  loading: boolean
  loaded: boolean
  error: string | null

  /* ---- document mode (an asset takes over the main column) ---- */
  /** Conversation slid over the document. Per chat, so switching chats resets it. */
  historyOpen: boolean
  /** Which asset the document is showing. Defaults to the newest; new assets steal it. */
  selectedAssetId: string | null
  /** Set when the chat's *first* asset lands live — DocumentView consumes it once to bloom. */
  bloom: boolean
  /** Streaming response sheets the reader waved away, by messageId. */
  dismissedSheets: Record<string, true>
}

/** One file going (or gone) through upload, staged above the composer until sent. */
export interface StagedUpload {
  localId: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  /** 0–1 transport progress; server-side indexing continues after 1. */
  progress: number
  /** Set once the server accepted the file into local sources. */
  sourceId?: string
  error?: string
}

export interface StoreState {
  /* chat list */
  chats: Chat[]
  chatsLoading: boolean
  activeChatId: string | null
  byChat: Record<string, ChatState>
  /** Chats with a successful interaction since their last exit-time title refresh. */
  titleDirty: Record<string, true>
  /**
   * The chat spawned by "New chat" that nobody has typed into yet. It only ever
   * exists while it is the active chat: clicking "New chat" again reuses it, and
   * navigating anywhere else throws it away so the sidebar can't fill with blanks.
   */
  draftChatId: string | null

  /* model selection */
  models: ModelInfo[]
  providers: ProviderInfo[]
  /** User-curated subset shown in every composer model picker. */
  enabledModelIds: string[]
  selectedModelId: string | null
  /** Chosen effort per model id, so switching models remembers each one's dial. */
  effortByModel: Record<string, string>
  /** Fork-thread override. `null` inherits the main selection until the user picks in the fork. */
  forkModelId: string | null
  /** Fork-thread effort overrides — never leak into the main chat's dials. */
  forkEffortByModel: Record<string, string>
  /** How much the next answer explains domain terms (the audience pebble). */
  elaboration: ElaborationLevel

  /* ui */
  theme: ThemeName
  forkOpen: boolean
  /**
   * A clicked in-asset mark targeting its fork message. The nonce retriggers
   * the scroll even when the same mark is clicked twice.
   */
  forkFocus: { messageId: string; nonce: number } | null
  /** Asset fragments staged above the fork composer for the next follow-up. */
  followUpAttachments: FollowUpAttachment[]
  /** Files uploading/uploaded for the next main-thread message. */
  stagedUploads: StagedUpload[]
  /** Composer text per chat+thread, keyed `${chatId}:${thread}` — survives chat switches. */
  drafts: Record<string, string>
  connection: SseStatus
  error: string | null
  providerAlert: { providerId: string; message: string } | null

  /* settings — the server owns this data, so none of it is persisted locally */
  settingsOpen: boolean
  settingsSection: SettingsSection
  /** Masked key status from the server. Empty until the page is first opened. */
  apiKeys: ApiKeyStatus[]
  personalization: Personalization
  settingsLoaded: boolean
  /** Save feedback for the settings page: keyed by field name. */
  settingsSaving: Record<string, boolean>
  settingsError: string | null

  /* actions */
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSection) => void
  loadSettings: () => Promise<void>
  saveApiKey: (name: string, value: string) => Promise<void>
  savePersonalization: (patch: Partial<Personalization>) => Promise<void>
  loadModels: () => Promise<void>
  refreshProviders: () => Promise<void>
  reconnectProvider: (providerId: string) => Promise<void>
  toggleModelEnabled: (modelId: string) => void
  setModel: (modelId: string) => void
  setEffort: (effort: string) => void
  setForkModel: (modelId: string) => void
  setForkEffort: (effort: string) => void
  setElaboration: (level: ElaborationLevel) => void
  loadChats: () => Promise<void>
  newChat: () => Promise<Chat | null>
  /** Drop the untouched draft chat (list + server). No-op if it was typed into. */
  discardDraft: () => void
  removeChat: (chatId: string) => Promise<void>
  openChat: (chatId: string) => Promise<void>
  closeChat: () => void
  retitleOnExit: (chatId?: string, keepalive?: boolean) => Promise<void>
  sendMessage: (
    thread: Thread,
    content: string,
    attachments?: FollowUpAttachment[],
  ) => Promise<void>
  applyEvent: (event: ChatEvent) => void
  applyEvents: (events: ChatEvent[]) => void
  resolveInput: (pendingInputId: string, value: string) => Promise<void>
  /** Stop the run on one thread; no argument stops every run in the chat. */
  stopRun: (thread?: Thread) => Promise<void>
  setForkOpen: (open: boolean) => void
  toggleFork: () => void
  /** Open the fork panel on the message that carries this attachment. */
  focusForkAttachment: (attachmentId: string) => void
  clearForkFocus: () => void
  addFollowUpAttachment: (attachment: Omit<FollowUpAttachment, 'label'>) => void
  removeFollowUpAttachment: (id: string) => void
  clearFollowUpAttachments: () => void
  /** Stash composer text for a chat+thread; an empty value drops the entry. */
  setDraft: (chatId: string, thread: Thread, value: string) => void
  /** The draft for a chat+thread ('' when none). */
  getDraft: (chatId: string, thread: Thread) => string
  /** Upload files into the active chat's local sources and stage them on the composer. */
  attachFiles: (files: File[]) => Promise<void>
  /** Unstage a file; if it already reached local sources, it is deleted there too. */
  removeStagedUpload: (localId: string) => void
  /** Drop the staged list (uploaded files stay in local sources). */
  clearStagedUploads: () => void
  /** Delete a file from the chat's local sources. */
  removeSource: (sourceId: string) => Promise<void>
  setHistoryOpen: (open: boolean) => void
  toggleHistory: () => void
  /** Show an asset in the document (and get out of the history overlay's way). */
  selectAsset: (assetId: string) => void
  /** Consume the one-shot bloom flag after the takeover animation has played. */
  clearBloom: () => void
  dismissSheet: (messageId: string) => void
  setTheme: (theme: ThemeName) => void
  toggleTheme: () => void
  dismissError: () => void
  dismissProviderAlert: () => void
}

/* ------------------------------------------------------------------- theme */

const THEME_KEY = 'rautml.theme'

function readStoredTheme(): ThemeName | null {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'light' || raw === 'dark' ? raw : null
  } catch {
    return null
  }
}

function systemTheme(): ThemeName {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function applyThemeToDom(theme: ThemeName) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

/** Resolve + stamp the initial theme. Call once, before first paint (main.tsx). */
export function initTheme(): ThemeName {
  const theme = readStoredTheme() ?? systemTheme()
  applyThemeToDom(theme)
  return theme
}

/* ---------------------------------------------------------- model selection */

const MODEL_KEY = 'rautml.model'
const EFFORT_KEY = 'rautml.efforts'
const FORK_MODEL_KEY = 'rautml.forkModel'
const FORK_EFFORT_KEY = 'rautml.forkEfforts'
const ENABLED_MODELS_KEY = 'rautml.enabledModels'
const ELABORATION_KEY = 'rautml.elaboration'

export const ELABORATION_LEVELS: ElaborationLevel[] = ['undergraduate', 'bachelors', 'doctor']

const DEFAULT_ELABORATION: ElaborationLevel = 'bachelors'

function readStoredElaboration(): ElaborationLevel {
  try {
    const raw = localStorage.getItem(ELABORATION_KEY)
    return ELABORATION_LEVELS.includes(raw as ElaborationLevel)
      ? (raw as ElaborationLevel)
      : DEFAULT_ELABORATION
  } catch {
    return DEFAULT_ELABORATION
  }
}

function readStoredModel(key: string = MODEL_KEY): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function readStoredEfforts(key: string = EFFORT_KEY): Record<string, string> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

function readEnabledModels(): string[] {
  try {
    const raw = localStorage.getItem(ENABLED_MODELS_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function persistEnabledModels(ids: string[]) {
  try {
    localStorage.setItem(ENABLED_MODELS_KEY, JSON.stringify(ids))
  } catch {
    /* private mode — the library stays available for this session */
  }
}

/** OpenRouter is configured outside the CLI flow; every other catalog requires a live CLI auth. */
function selectableModelIds(models: ModelInfo[], providers: ProviderInfo[]): Set<string> {
  const selectableProviders = new Set(
    providers
      .filter((provider) => provider.id === 'openrouter' || provider.authStatus === 'connected')
      .map((provider) => provider.id),
  )
  return new Set(
    models.filter((model) => selectableProviders.has(model.providerId)).map((model) => model.id),
  )
}

function persistSelection(modelId: string | null, efforts: Record<string, string>) {
  try {
    if (modelId) localStorage.setItem(MODEL_KEY, modelId)
    localStorage.setItem(EFFORT_KEY, JSON.stringify(efforts))
  } catch {
    /* private mode — selection just won't persist */
  }
}

function persistForkSelection(modelId: string | null, efforts: Record<string, string>) {
  try {
    if (modelId) localStorage.setItem(FORK_MODEL_KEY, modelId)
    else localStorage.removeItem(FORK_MODEL_KEY)
    localStorage.setItem(FORK_EFFORT_KEY, JSON.stringify(efforts))
  } catch {
    /* private mode — selection just won't persist */
  }
}

/* --------------------------------------------------------------- factories */

function emptyChatState(chat: Chat): ChatState {
  return {
    chat,
    messages: { main: [], fork: [] },
    timelines: {},
    runOrder: [],
    currentRunId: { main: null, fork: null },
    activeRun: { main: null, fork: null },
    assets: [],
    assetsByMessage: {},
    widgets: {},
    files: {},
    sources: [],
    inputRequests: { main: [], fork: [] },
    pendingInput: null,
    lastSeq: 0,
    loading: false,
    loaded: false,
    error: null,
    historyOpen: false,
    selectedAssetId: null,
    bloom: false,
    dismissedSheets: {},
  }
}

/** Newest asset first — the order the switcher lists them in. */
export function assetsNewestFirst(assets: Asset[]): Asset[] {
  return assets.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

function isLive(status: Run['status']): boolean {
  return status === 'running' || status === 'awaiting_input'
}

/** True once the first main back-and-forth is complete, even if Luna is still titling it. */
function isAfterInitialExchange(cs: ChatState): boolean {
  if (cs.chat.title && cs.chat.title !== 'New chat') return true
  return (
    !cs.activeRun.main &&
    cs.messages.main.some((message) => message.role === 'user') &&
    cs.messages.main.some(
      (message) =>
        message.role === 'assistant' &&
        message.status === 'complete' &&
        message.content.trim().length > 0,
    )
  )
}

/** Something is in this chat: a message on either thread, or a run. */
function hasContent(cs: ChatState | undefined): boolean {
  if (!cs) return false
  return (
    cs.messages.main.length > 0 ||
    cs.messages.fork.length > 0 ||
    cs.runOrder.length > 0 ||
    !!cs.activeRun.main ||
    !!cs.activeRun.fork
  )
}

/**
 * Nothing has happened in this chat yet. `loaded` matters here — an unfetched
 * chat looks empty but isn't *known* to be, so we don't treat it as blank.
 */
function isUntouched(cs: ChatState | undefined): boolean {
  return !!cs && cs.loaded && !hasContent(cs)
}

/* --------------------------------------------------------------- reduction */

interface ReduceCtx {
  /** True while replaying persisted events from GET /api/chats/:id. */
  hydrating: boolean
  /** messageIds whose content was reset once during hydration replay. */
  resetDuringHydration: Set<string>
}

function ensureTimeline(cs: ChatState, runId: string, thread: Thread, at: number): ChatState {
  if (cs.timelines[runId]) return cs
  const timeline: RunTimeline = {
    runId,
    thread,
    status: 'running',
    items: [],
    startedAt: at,
  }
  return {
    ...cs,
    timelines: { ...cs.timelines, [runId]: timeline },
    runOrder: [...cs.runOrder, runId],
  }
}

function patchTimeline(
  cs: ChatState,
  runId: string,
  patch: (t: RunTimeline) => RunTimeline,
): ChatState {
  const existing = cs.timelines[runId]
  if (!existing) return cs
  return { ...cs, timelines: { ...cs.timelines, [runId]: patch(existing) } }
}

/**
 * Patch one subagent, wherever it lives. Located like tool.end locates its
 * run: search every timeline first, fall back to the thread's current run.
 */
function patchSubagent(
  cs: ChatState,
  thread: Thread,
  subagentId: string,
  patch: (s: SubagentRun) => SubagentRun,
): ChatState {
  const runId =
    cs.runOrder.find((id) =>
      cs.timelines[id]?.subagents?.some((s) => s.subagentId === subagentId),
    ) ?? cs.currentRunId[thread]
  if (!runId) return cs
  return patchTimeline(cs, runId, (t) => {
    const subagents = t.subagents ?? []
    const idx = subagents.findIndex((s) => s.subagentId === subagentId)
    if (idx === -1) return t
    const next = subagents.slice()
    next[idx] = patch(subagents[idx]!)
    return { ...t, subagents: next }
  })
}

function patchMessage(
  cs: ChatState,
  thread: Thread,
  messageId: string,
  patch: (m: Message) => Message,
): ChatState {
  const list = cs.messages[thread]
  const idx = list.findIndex((m) => m.id === messageId)
  if (idx === -1) return cs
  const next = list.slice()
  next[idx] = patch(list[idx]!)
  return { ...cs, messages: { ...cs.messages, [thread]: next } }
}

/** The single event reducer — handles every type in CONTRACT.md § SSE events. */
function reduceEvent(cs: ChatState, ev: ChatEvent, ctx: ReduceCtx): ChatState {
  const thread: Thread = ev.thread === 'fork' ? 'fork' : 'main'
  // Server-recorded wall clock. Everything timestamped below uses it, so durations survive
  // a reload — hydrating from `Date.now()` is what used to collapse runs to "0.1s".
  const at = Number.isFinite(ev.at) && (ev.at as number) > 0 ? ev.at : Date.now()
  let next = cs

  switch (ev.type) {
    case 'run.status': {
      const d = ev.data as RunStatusEvent
      if (!d?.runId) break
      next = ensureTimeline(next, d.runId, thread, at)
      next = {
        ...next,
        currentRunId: { ...next.currentRunId, [thread]: d.runId },
        activeRun: {
          ...next.activeRun,
          [thread]: isLive(d.status)
            ? { id: d.runId, chatId: cs.chat.id, thread, status: d.status }
            : null,
        },
      }
      next = patchTimeline(next, d.runId, (t) => ({
        ...t,
        status: d.status,
        endedAt: isLive(d.status) ? undefined : (t.endedAt ?? at),
        // A run that stopped is not thinking about anything.
        phase: isLive(d.status) ? t.phase : undefined,
        phaseLabel: isLive(d.status) ? t.phaseLabel : undefined,
      }))
      if (!isLive(d.status)) {
        // A finished run can never still be waiting on input.
        next = { ...next, pendingInput: null }
        // Any tool left hanging is marked done so the timeline never spins forever.
        next = patchTimeline(next, d.runId, (t) =>
          t.items.some((i) => i.status === 'running')
            ? {
                ...t,
                items: t.items.map((i) =>
                  i.status === 'running'
                    ? { ...i, status: d.status === 'error' ? 'error' : 'ok', endedAt: at }
                    : i,
                ),
              }
            : t,
        )
        // Subagents can't outlive their run either.
        next = patchTimeline(next, d.runId, (t) =>
          t.subagents?.some((s) => s.status === 'running')
            ? {
                ...t,
                subagents: t.subagents.map((s) =>
                  s.status === 'running'
                    ? {
                        ...s,
                        status: d.status === 'error' ? 'error' : 'ok',
                        endedAt: s.endedAt ?? at,
                        items: s.items.map((i) =>
                          i.status === 'running'
                            ? { ...i, status: d.status === 'error' ? 'error' : 'ok', endedAt: at }
                            : i,
                        ),
                      }
                    : s,
                ),
              }
            : t,
        )
        // Nothing should be left streaming.
        next = {
          ...next,
          messages: {
            ...next.messages,
            [thread]: next.messages[thread].map((m) =>
              m.status === 'streaming' && m.runId === d.runId
                ? { ...m, status: d.status === 'error' ? 'error' : 'complete' }
                : m,
            ),
          },
        }
      }
      break
    }

    case 'run.phase': {
      const d = ev.data as RunPhaseEvent
      if (!d?.runId || !d.phase) break
      next = ensureTimeline(next, d.runId, thread, at)
      next = patchTimeline(next, d.runId, (t) => ({
        ...t,
        phase: d.phase,
        phaseLabel: d.label || undefined,
      }))
      break
    }

    case 'message.start': {
      const d = ev.data as MessageStartEvent
      if (!d?.messageId) break
      const runId = next.currentRunId[thread] ?? undefined
      const list = next.messages[thread]
      const existing = list.findIndex((m) => m.id === d.messageId)
      if (existing !== -1) {
        next = patchMessage(next, thread, d.messageId, (m) => ({ ...m, status: 'streaming', runId }))
        break
      }
      // Adopt the optimistic local user bubble instead of duplicating it.
      if (d.role === 'user') {
        const localIdx = list.findIndex((m) => m.role === 'user' && m.id.startsWith('local-'))
        if (localIdx !== -1) {
          const nextList = list.slice()
          nextList[localIdx] = { ...list[localIdx]!, id: d.messageId, status: 'complete', runId }
          next = { ...next, messages: { ...next.messages, [thread]: nextList } }
          break
        }
      }
      const message: Message = {
        id: d.messageId,
        chatId: cs.chat.id,
        thread,
        role: d.role ?? 'assistant',
        content: '',
        status: 'streaming',
        runId,
        createdAt: at,
      }
      next = { ...next, messages: { ...next.messages, [thread]: [...list, message] } }
      break
    }

    case 'message.delta': {
      const d = ev.data as MessageDeltaEvent
      if (!d?.messageId || typeof d.text !== 'string') break
      // On hydration the DB row may already hold partial text; deltas rebuild it exactly once.
      const reset = ctx.hydrating && !ctx.resetDuringHydration.has(d.messageId)
      if (reset) ctx.resetDuringHydration.add(d.messageId)
      next = patchMessage(next, thread, d.messageId, (m) => ({
        ...m,
        content: (reset ? '' : m.content) + d.text,
        status: m.status === 'error' ? 'error' : 'streaming',
      }))
      break
    }

    case 'message.complete': {
      const d = ev.data as MessageCompleteEvent
      if (!d?.messageId) break
      next = patchMessage(next, thread, d.messageId, (m) => ({
        ...m,
        content: typeof d.content === 'string' && d.content.length ? d.content : m.content,
        status: 'complete',
      }))
      break
    }

    case 'tool.start': {
      const d = ev.data as ToolStartEvent
      const runId = next.currentRunId[thread]
      if (!d?.toolCallId || !runId) break
      next = ensureTimeline(next, runId, thread, at)
      next = patchTimeline(next, runId, (t) => {
        const idx = t.items.findIndex((i) => i.toolCallId === d.toolCallId)
        if (idx !== -1) {
          // The engine announces a call from the live stream first, then emits
          // tool.start again with the full label once the arguments are known.
          const items = t.items.slice()
          const existing = items[idx]!
          items[idx] = {
            ...existing,
            name: d.name ?? existing.name,
            label: d.label ?? existing.label,
          }
          return { ...t, items }
        }
        return {
          ...t,
          // The summary clock starts at the first real step of the run.
          firstStepAt: t.firstStepAt ?? at,
          items: [
            ...t.items,
            {
              toolCallId: d.toolCallId,
              name: d.name,
              label: d.label ?? d.name,
              status: 'running',
              startedAt: at,
            } satisfies TimelineItem,
          ],
        }
      })
      break
    }

    case 'tool.end': {
      const d = ev.data as ToolEndEvent
      if (!d?.toolCallId) break
      const runId =
        next.runOrder.find((id) =>
          next.timelines[id]?.items.some((i) => i.toolCallId === d.toolCallId),
        ) ?? next.currentRunId[thread]
      if (!runId) break
      next = ensureTimeline(next, runId, thread, at)
      next = patchTimeline(next, runId, (t) => {
        const firstStepAt = t.firstStepAt ?? at
        const has = t.items.some((i) => i.toolCallId === d.toolCallId)
        const items = has
          ? t.items.map((i) =>
              i.toolCallId === d.toolCallId
                ? { ...i, status: d.ok ? 'ok' : 'error', summary: d.summary, endedAt: at }
                : i,
            )
          : [
              ...t.items,
              {
                toolCallId: d.toolCallId,
                name: d.name,
                label: d.name,
                status: d.ok ? 'ok' : 'error',
                summary: d.summary,
                startedAt: at,
                endedAt: at,
              } satisfies TimelineItem,
            ]
        return { ...t, firstStepAt, items: items as TimelineItem[] }
      })
      break
    }

    case 'thinking.start': {
      const d = ev.data as ThinkingStartEvent
      const runId = next.currentRunId[thread]
      if (!d?.thinkingId || !runId) break
      next = ensureTimeline(next, runId, thread, at)
      next = patchTimeline(next, runId, (t) => {
        // Replay-safe: the row was already created by an earlier pass.
        if (t.items.some((i) => i.toolCallId === d.thinkingId)) return t
        return {
          ...t,
          // The summary clock starts at the first real step of the run.
          firstStepAt: t.firstStepAt ?? at,
          items: [
            ...t.items,
            {
              toolCallId: d.thinkingId,
              kind: 'thinking',
              name: 'thinking',
              label: 'Thinking',
              status: 'running',
              startedAt: at,
            } satisfies TimelineItem,
          ],
        }
      })
      break
    }

    case 'thinking.delta': {
      const d = ev.data as ThinkingDeltaEvent
      if (!d?.thinkingId || typeof d.text !== 'string') break
      const runId =
        next.runOrder.find((id) =>
          next.timelines[id]?.items.some((i) => i.toolCallId === d.thinkingId),
        ) ?? next.currentRunId[thread]
      if (!runId) break
      // No hydration reset needed: items are created fresh during replay, so
      // deltas rebuild the trace exactly once.
      next = patchTimeline(next, runId, (t) => ({
        ...t,
        items: t.items.map((i) =>
          i.toolCallId === d.thinkingId ? { ...i, trace: (i.trace ?? '') + d.text } : i,
        ),
      }))
      break
    }

    case 'thinking.end': {
      const d = ev.data as ThinkingEndEvent
      if (!d?.thinkingId) break
      const runId =
        next.runOrder.find((id) =>
          next.timelines[id]?.items.some((i) => i.toolCallId === d.thinkingId),
        ) ?? next.currentRunId[thread]
      if (!runId) break
      next = ensureTimeline(next, runId, thread, at)
      next = patchTimeline(next, runId, (t) => {
        const firstStepAt = t.firstStepAt ?? at
        const has = t.items.some((i) => i.toolCallId === d.thinkingId)
        const items = has
          ? t.items.map((i) =>
              i.toolCallId === d.thinkingId
                ? { ...i, status: 'ok' as const, endedAt: at, ms: d.ms }
                : i,
            )
          : [
              ...t.items,
              // Edge: replay window started mid-run — create the row completed.
              {
                toolCallId: d.thinkingId,
                kind: 'thinking',
                name: 'thinking',
                label: 'Thinking',
                status: 'ok',
                startedAt: at - (d.ms ?? 0),
                endedAt: at,
                ms: d.ms,
              } satisfies TimelineItem,
            ]
        return { ...t, firstStepAt, items }
      })
      break
    }

    case 'asset.created': {
      const d = ev.data as AssetCreatedEvent
      const incoming = d?.asset
      if (!incoming?.id) break
      const asset: Asset = { ...incoming, latestVersion: incoming.latestVersion ?? d.version ?? 1 }
      const isFirst = next.assets.length === 0
      if (next.assets.some((a) => a.id === asset.id)) {
        next = { ...next, assets: next.assets.map((a) => (a.id === asset.id ? { ...a, ...asset } : a)) }
      } else {
        next = { ...next, assets: [...next.assets, asset] }
      }
      // A fresh asset takes the stage; the very first one also earns the takeover bloom.
      next = {
        ...next,
        selectedAssetId: asset.id,
        historyOpen: ctx.hydrating ? next.historyOpen : false,
        bloom: next.bloom || (isFirst && !ctx.hydrating),
      }
      if (asset.messageId) {
        const current = next.assetsByMessage[asset.messageId] ?? []
        if (!current.includes(asset.id)) {
          next = {
            ...next,
            assetsByMessage: {
              ...next.assetsByMessage,
              [asset.messageId]: [...current, asset.id],
            },
          }
        }
      }
      break
    }

    case 'asset.version': {
      const d = ev.data as AssetVersionEvent
      if (!d?.assetId) break
      next = {
        ...next,
        assets: next.assets.map((a) =>
          a.id === d.assetId
            ? { ...a, latestVersion: Math.max(a.latestVersion ?? 1, d.version ?? 1) }
            : a,
        ),
      }
      break
    }

    case 'widget': {
      const d = ev.data as WidgetEvent
      if (!d?.messageId || typeof d.html !== 'string') break
      const current = next.widgets[d.messageId] ?? []
      if (current.includes(d.html)) break
      next = { ...next, widgets: { ...next.widgets, [d.messageId]: [...current, d.html] } }
      break
    }

    case 'files.presented': {
      const d = ev.data as FilesPresentedEvent
      if (!d?.messageId || !Array.isArray(d.files)) break
      const current = next.files[d.messageId] ?? []
      const merged = [...current]
      for (const f of d.files) if (!merged.some((x) => x.relPath === f.relPath)) merged.push(f)
      next = { ...next, files: { ...next.files, [d.messageId]: merged } }
      break
    }

    case 'input.request': {
      const d = ev.data as InputRequestEvent
      if (!d?.pendingInputId) break
      const list = next.inputRequests[thread]
      const request: InputRequest = {
        id: d.pendingInputId,
        chatId: cs.chat.id,
        thread,
        runId: next.currentRunId[thread] ?? undefined,
        question: d.question,
        options: Array.isArray(d.options) ? d.options : [],
        resolved: false,
        createdAt: at,
      }
      next = {
        ...next,
        inputRequests: {
          ...next.inputRequests,
          [thread]: list.some((r) => r.id === request.id)
            ? list.map((r) => (r.id === request.id ? { ...r, ...request, resolved: r.resolved, value: r.value } : r))
            : [...list, request],
        },
        pendingInput: { id: request.id, question: request.question, options: request.options },
      }
      break
    }

    case 'input.resolved': {
      const d = ev.data as InputResolvedEvent
      if (!d?.pendingInputId) break
      next = {
        ...next,
        inputRequests: {
          ...next.inputRequests,
          [thread]: next.inputRequests[thread].map((r) =>
            r.id === d.pendingInputId ? { ...r, resolved: true, value: d.value } : r,
          ),
        },
        pendingInput: next.pendingInput?.id === d.pendingInputId ? null : next.pendingInput,
      }
      break
    }

    case 'chat.title': {
      const d = ev.data as ChatTitleEvent
      if (!d?.title) break
      next = { ...next, chat: { ...next.chat, title: d.title } }
      break
    }

    case 'source.added':
    case 'source.updated': {
      const d = ev.data as SourceAddedEvent | SourceUpdatedEvent
      if (!d?.source?.id) break
      const exists = next.sources.some((s) => s.id === d.source.id)
      next = {
        ...next,
        sources: exists
          ? next.sources.map((s) => (s.id === d.source.id ? { ...s, ...d.source } : s))
          : [...next.sources, d.source],
      }
      break
    }

    case 'source.removed': {
      const d = ev.data as SourceRemovedEvent
      if (!d?.sourceId) break
      next = { ...next, sources: next.sources.filter((s) => s.id !== d.sourceId) }
      break
    }

    case 'subagent.start': {
      const d = ev.data as SubagentStartEvent
      const runId = next.currentRunId[thread]
      if (!d?.subagentId || !runId) break
      next = ensureTimeline(next, runId, thread, at)
      next = patchTimeline(next, runId, (t) => {
        const subagents = t.subagents ?? []
        if (subagents.some((s) => s.subagentId === d.subagentId)) return t
        return {
          ...t,
          firstStepAt: t.firstStepAt ?? at,
          subagents: [
            ...subagents,
            {
              subagentId: d.subagentId,
              parentToolCallId: d.parentToolCallId ?? '',
              title: d.title || 'Research agent',
              model: d.model ?? '',
              status: 'running',
              text: '',
              items: [],
              startedAt: at,
            } satisfies SubagentRun,
          ],
        }
      })
      break
    }

    case 'subagent.delta': {
      const d = ev.data as SubagentDeltaEvent
      if (!d?.subagentId || typeof d.text !== 'string') break
      // Text exists only as deltas (no DB row to reset), so appending is exact
      // both live and during replay.
      next = patchSubagent(next, thread, d.subagentId, (s) => ({ ...s, text: s.text + d.text }))
      break
    }

    case 'subagent.tool.start': {
      const d = ev.data as SubagentToolStartEvent
      if (!d?.subagentId || !d.toolCallId) break
      next = patchSubagent(next, thread, d.subagentId, (s) =>
        s.items.some((i) => i.toolCallId === d.toolCallId)
          ? s
          : {
              ...s,
              items: [
                ...s.items,
                {
                  toolCallId: d.toolCallId,
                  name: d.name,
                  label: d.label ?? d.name,
                  status: 'running',
                  startedAt: at,
                } satisfies TimelineItem,
              ],
            },
      )
      break
    }

    case 'subagent.tool.end': {
      const d = ev.data as SubagentToolEndEvent
      if (!d?.subagentId || !d.toolCallId) break
      next = patchSubagent(next, thread, d.subagentId, (s) => ({
        ...s,
        items: s.items.some((i) => i.toolCallId === d.toolCallId)
          ? s.items.map((i) =>
              i.toolCallId === d.toolCallId
                ? { ...i, status: d.ok ? ('ok' as const) : ('error' as const), summary: d.summary, endedAt: at }
                : i,
            )
          : [
              ...s.items,
              {
                toolCallId: d.toolCallId,
                name: d.name,
                label: d.name,
                status: d.ok ? 'ok' : 'error',
                summary: d.summary,
                startedAt: at,
                endedAt: at,
              } satisfies TimelineItem,
            ],
      }))
      break
    }

    case 'subagent.end': {
      const d = ev.data as SubagentEndEvent
      if (!d?.subagentId) break
      next = patchSubagent(next, thread, d.subagentId, (s) => ({
        ...s,
        status: d.ok ? 'ok' : 'error',
        summary: d.summary,
        endedAt: at,
        items: s.items.map((i) =>
          i.status === 'running' ? { ...i, status: d.ok ? ('ok' as const) : ('error' as const), endedAt: at } : i,
        ),
      }))
      break
    }

    default:
      break
  }

  return next.lastSeq >= ev.seq ? next : { ...next, lastSeq: ev.seq }
}

function hydrate(snapshot: ChatSnapshot): ChatState {
  let cs = emptyChatState(snapshot.chat)

  for (const m of snapshot.messages ?? []) {
    const thread: Thread = m.thread === 'fork' ? 'fork' : 'main'
    cs = { ...cs, messages: { ...cs.messages, [thread]: [...cs.messages[thread], m] } }
  }

  for (const a of snapshot.assets ?? []) {
    const asset: Asset = {
      id: a.id,
      chatId: a.chatId,
      messageId: a.messageId,
      title: a.title,
      latestVersion: a.latestVersion ?? (a.versions?.length ? Math.max(...a.versions.map((v) => v.version)) : 1),
      createdAt: a.createdAt,
    }
    cs = { ...cs, assets: [...cs.assets, asset] }
    if (asset.messageId) {
      const current = cs.assetsByMessage[asset.messageId] ?? []
      cs = {
        ...cs,
        assetsByMessage: { ...cs.assetsByMessage, [asset.messageId]: [...current, asset.id] },
      }
    }
  }

  // Snapshot rows are authoritative; the event replay below only merges newer
  // states on top (a source.updated arriving mid-hydration must not be lost).
  cs = { ...cs, sources: snapshot.sources ?? [] }

  const ctx: ReduceCtx = { hydrating: true, resetDuringHydration: new Set() }
  for (const ev of snapshot.events ?? []) cs = reduceEvent(cs, ev, ctx)

  if (snapshot.activeRun) {
    const thread: Thread = snapshot.activeRun.thread === 'fork' ? 'fork' : 'main'
    cs = ensureTimeline(cs, snapshot.activeRun.id, thread, Date.now())
    cs = {
      ...cs,
      currentRunId: { ...cs.currentRunId, [thread]: snapshot.activeRun.id },
      activeRun: {
        ...cs.activeRun,
        [thread]: isLive(snapshot.activeRun.status) ? snapshot.activeRun : null,
      },
    }
  }
  if (snapshot.pendingInput) cs = { ...cs, pendingInput: snapshot.pendingInput }

  // Opening a chat that already has assets lands straight in document mode, on the newest
  // one, with no animation and the conversation tucked away.
  const newest = assetsNewestFirst(cs.assets)[0] ?? null
  if (!cs.selectedAssetId || !cs.assets.some((a) => a.id === cs.selectedAssetId)) {
    cs = { ...cs, selectedAssetId: newest?.id ?? null }
  }

  return { ...cs, loading: false, loaded: true, historyOpen: false, bloom: false }
}

/** `set(...)` helper for UI bits that live on the *active* chat's state. */
function patchActive(patch: (cs: ChatState) => ChatState) {
  return (s: StoreState): Partial<StoreState> => {
    const chatId = s.activeChatId
    if (!chatId) return {}
    const cs = s.byChat[chatId]
    if (!cs) return {}
    const next = patch(cs)
    return next === cs ? {} : { byChat: { ...s.byChat, [chatId]: next } }
  }
}

/* ------------------------------------------------------------ sse plumbing */

let connection: SseConnection | null = null
let eventFlushTimer: number | null = null
let queuedEvents: ChatEvent[] = []

const MAX_CACHED_CHATS = 3
const recentChatIds: string[] = []

/** Guards against a double-click racing two POST /api/chats before either lands. */
let creatingChat = false

function rememberChat(chatId: string) {
  const previous = recentChatIds.indexOf(chatId)
  if (previous !== -1) recentChatIds.splice(previous, 1)
  recentChatIds.push(chatId)
  if (recentChatIds.length > MAX_CACHED_CHATS * 4) {
    recentChatIds.splice(0, recentChatIds.length - MAX_CACHED_CHATS * 4)
  }
}

function pruneChatCache(byChat: Record<string, ChatState>): Record<string, ChatState> {
  if (Object.keys(byChat).length <= MAX_CACHED_CHATS) return byChat
  const keep = new Set(recentChatIds.slice(-MAX_CACHED_CHATS))
  const next: Record<string, ChatState> = {}
  for (const [id, state] of Object.entries(byChat)) if (keep.has(id)) next[id] = state
  return next
}

function deltaKey(event: ChatEvent): string | null {
  if (!event.data || typeof event.data !== 'object') return null
  const data = event.data as Record<string, unknown>
  if (event.type === 'message.delta' && typeof data.messageId === 'string') {
    return `${event.chatId}:${event.thread}:message:${data.messageId}`
  }
  if (event.type === 'thinking.delta' && typeof data.thinkingId === 'string') {
    return `${event.chatId}:${event.thread}:thinking:${data.thinkingId}`
  }
  if (event.type === 'subagent.delta' && typeof data.subagentId === 'string') {
    return `${event.chatId}:${event.thread}:subagent:${data.subagentId}`
  }
  return null
}

function coalesceQueuedEvents(events: ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = []
  for (const event of events) {
    const key = deltaKey(event)
    const previous = out[out.length - 1]
    if (key && previous && deltaKey(previous) === key) {
      const previousData = previous.data as Record<string, unknown>
      const data = event.data as Record<string, unknown>
      out[out.length - 1] = {
        ...event,
        data: { ...data, text: String(previousData.text ?? '') + String(data.text ?? '') },
      }
    } else {
      out.push(event)
    }
  }
  return out
}

function flushQueuedEvents() {
  if (eventFlushTimer !== null) window.clearTimeout(eventFlushTimer)
  eventFlushTimer = null
  if (!queuedEvents.length) return
  const batch = coalesceQueuedEvents(queuedEvents)
  queuedEvents = []
  useStore.getState().applyEvents(batch)
}

function enqueueEvent(event: ChatEvent) {
  queuedEvents.push(event)
  if (eventFlushTimer === null) eventFlushTimer = window.setTimeout(flushQueuedEvents, 16)
}

function clearQueuedEvents() {
  if (eventFlushTimer !== null) window.clearTimeout(eventFlushTimer)
  eventFlushTimer = null
  queuedEvents = []
}

function disconnect() {
  if (queuedEvents.length) flushQueuedEvents()
  else clearQueuedEvents()
  connection?.close()
  connection = null
}

/**
 * A hidden tab can get its stream killed (or its backoff timer frozen) without any
 * event firing, so coming back forces an immediate resume from lastSeq instead of
 * waiting out the retry. Guards: no connection → no active chat; a healthy or
 * in-flight connect is left alone; and reconnect() flips the status synchronously,
 * so the paired focus + visibility events of one tab return can't storm.
 */
function reconnectActiveStream() {
  if (!connection) return
  const status = useStore.getState().connection
  if (status === 'open' || status === 'connecting') return
  connection.reconnect()
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectActiveStream()
  })
  window.addEventListener('focus', reconnectActiveStream)
}

/* ------------------------------------------------------------------- store */

export const useStore = create<StoreState>()((set, get) => ({
  chats: [],
  chatsLoading: false,
  activeChatId: null,
  byChat: {},
  titleDirty: {},
  draftChatId: null,

  models: [],
  providers: [],
  enabledModelIds: readEnabledModels(),
  selectedModelId: readStoredModel(),
  effortByModel: readStoredEfforts(),
  forkModelId: readStoredModel(FORK_MODEL_KEY),
  forkEffortByModel: readStoredEfforts(FORK_EFFORT_KEY),
  elaboration: readStoredElaboration(),

  theme: typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light',
  forkOpen: false,
  forkFocus: null,
  followUpAttachments: [],
  stagedUploads: [],
  drafts: {},
  connection: 'closed',
  error: null,
  providerAlert: null,

  settingsOpen: false,
  settingsSection: 'models',
  apiKeys: [],
  personalization: { designPreferences: '', aboutMe: '' },
  settingsLoaded: false,
  settingsSaving: {},
  settingsError: null,

  openSettings: (section) => {
    set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection }))
    // Fetch once per session; later opens render the state already in hand.
    if (!get().settingsLoaded) void get().loadSettings()
  },

  closeSettings: () => set({ settingsOpen: false, settingsError: null }),

  setSettingsSection: (section) => set({ settingsSection: section }),

  loadSettings: async () => {
    try {
      const { keys, personalization } = await api.getSettings()
      set({ apiKeys: keys, personalization, settingsLoaded: true, settingsError: null })
    } catch (err) {
      set({ settingsError: err instanceof Error ? err.message : 'Could not load settings' })
    }
  },

  saveApiKey: async (name, value) => {
    set((s) => ({ settingsSaving: { ...s.settingsSaving, [name]: true }, settingsError: null }))
    try {
      const { keys } = await api.saveApiKeys({ [name]: value })
      set({ apiKeys: keys })
      // A key can change a provider's auth status (OpenRouter), and the server
      // has already dropped its discovery cache — pick the new status up now.
      void get().refreshProviders()
    } catch (err) {
      set({ settingsError: err instanceof Error ? err.message : 'Could not save that key' })
    } finally {
      set((s) => {
        const settingsSaving = { ...s.settingsSaving }
        delete settingsSaving[name]
        return { settingsSaving }
      })
    }
  },

  savePersonalization: async (patch) => {
    const fields = Object.keys(patch)
    set((s) => ({
      settingsSaving: { ...s.settingsSaving, ...Object.fromEntries(fields.map((f) => [f, true])) },
      settingsError: null,
    }))
    try {
      const { personalization } = await api.savePersonalization(patch)
      set({ personalization })
    } catch (err) {
      set({ settingsError: err instanceof Error ? err.message : 'Could not save that preference' })
    } finally {
      set((s) => {
        const settingsSaving = { ...s.settingsSaving }
        for (const field of fields) delete settingsSaving[field]
        return { settingsSaving }
      })
    }
  },

  loadModels: async () => {
    try {
      const { models, providers, defaultModelId } = await api.listModels()
      set((s) => {
        const validIds = selectableModelIds(models, providers)
        let enabledModelIds = s.enabledModelIds.filter((id) => validIds.has(id))
        if (!enabledModelIds.length) {
          enabledModelIds = models.filter((model) => validIds.has(model.id)).map((model) => model.id)
        }
        const enabled = new Set(enabledModelIds)
        // Stale localStorage (a model removed from the catalog) falls back to the default.
        const stored = s.selectedModelId
        const selectedModelId =
          stored && enabled.has(stored) ? stored : enabledModelIds[0] ?? defaultModelId
        // Drop remembered efforts that the provider no longer offers.
        const effortByModel: Record<string, string> = {}
        for (const m of models) {
          const remembered = s.effortByModel[m.id]
          if (remembered && m.efforts.includes(remembered)) effortByModel[m.id] = remembered
        }
        // Same hygiene for the fork override; a stale model falls back to inherit.
        const forkModelId = s.forkModelId && enabled.has(s.forkModelId) ? s.forkModelId : null
        const forkEffortByModel: Record<string, string> = {}
        for (const m of models) {
          const remembered = s.forkEffortByModel[m.id]
          if (remembered && m.efforts.includes(remembered)) forkEffortByModel[m.id] = remembered
        }
        persistSelection(selectedModelId, effortByModel)
        persistForkSelection(forkModelId, forkEffortByModel)
        persistEnabledModels(enabledModelIds)
        return { models, providers, enabledModelIds, selectedModelId, effortByModel, forkModelId, forkEffortByModel }
      })
    } catch (err) {
      // The composer falls back to the server-side default model; not fatal.
      console.error('[store] loadModels failed', err)
    }
  },

  refreshProviders: async () => {
    try {
      const { models, providers, defaultModelId } = await api.listModels(true)
      set((s) => {
        const previousSelectableIds = selectableModelIds(s.models, s.providers)
        const previouslyAllEnabled =
          previousSelectableIds.size > 0 &&
          s.enabledModelIds.filter((id) => previousSelectableIds.has(id)).length === previousSelectableIds.size
        const validIds = selectableModelIds(models, providers)
        let enabledModelIds = previouslyAllEnabled
          ? models.filter((model) => validIds.has(model.id)).map((model) => model.id)
          : s.enabledModelIds.filter((id) => validIds.has(id))
        if (!enabledModelIds.length) {
          enabledModelIds = models.filter((model) => validIds.has(model.id)).map((model) => model.id)
        }
        const selectedModelId = enabledModelIds.includes(s.selectedModelId ?? '')
          ? s.selectedModelId
          : enabledModelIds[0] ?? defaultModelId
        const forkModelId = s.forkModelId && enabledModelIds.includes(s.forkModelId)
          ? s.forkModelId
          : null
        const providerAlert =
          s.providerAlert &&
          providers.some(
            (provider) =>
              provider.id === s.providerAlert?.providerId && provider.authStatus === 'connected',
          )
            ? null
            : s.providerAlert
        persistSelection(selectedModelId, s.effortByModel)
        persistForkSelection(forkModelId, s.forkEffortByModel)
        persistEnabledModels(enabledModelIds)
        return { models, providers, enabledModelIds, selectedModelId, forkModelId, providerAlert }
      })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  reconnectProvider: async (providerId) => {
    try {
      const result = await api.reconnectProvider(providerId)
      if (!result.launched) set({ error: result.command })
      else set({ providerAlert: { providerId, message: 'Finish signing in in Terminal, then refresh providers.' } })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  toggleModelEnabled: (modelId) =>
    set((s) => {
      if (!selectableModelIds(s.models, s.providers).has(modelId)) return {}
      const currentlyEnabled = s.enabledModelIds.includes(modelId)
      if (currentlyEnabled && s.enabledModelIds.length === 1) return {}
      const nextSet = new Set(s.enabledModelIds)
      if (currentlyEnabled) nextSet.delete(modelId)
      else nextSet.add(modelId)
      const enabledModelIds = s.models.filter((model) => nextSet.has(model.id)).map((model) => model.id)
      const selectedModelId = enabledModelIds.includes(s.selectedModelId ?? '')
        ? s.selectedModelId
        : enabledModelIds[0] ?? null
      const forkModelId = s.forkModelId && enabledModelIds.includes(s.forkModelId)
        ? s.forkModelId
        : null
      persistEnabledModels(enabledModelIds)
      persistSelection(selectedModelId, s.effortByModel)
      persistForkSelection(forkModelId, s.forkEffortByModel)
      return { enabledModelIds, selectedModelId, forkModelId }
    }),

  setModel: (modelId) =>
    set((s) => {
      if (!s.enabledModelIds.includes(modelId) || !selectableModelIds(s.models, s.providers).has(modelId)) return {}
      persistSelection(modelId, s.effortByModel)
      return { selectedModelId: modelId }
    }),

  setEffort: (effort) =>
    set((s) => {
      const model = s.models.find((m) => m.id === s.selectedModelId)
      if (!model || !model.efforts.includes(effort)) return {}
      const effortByModel = { ...s.effortByModel, [model.id]: effort }
      persistSelection(s.selectedModelId, effortByModel)
      return { effortByModel }
    }),

  setForkModel: (modelId) =>
    set((s) => {
      if (!s.enabledModelIds.includes(modelId) || !selectableModelIds(s.models, s.providers).has(modelId)) return {}
      persistForkSelection(modelId, s.forkEffortByModel)
      return { forkModelId: modelId }
    }),

  setForkEffort: (effort) =>
    set((s) => {
      const id = s.forkModelId ?? s.selectedModelId
      const model = s.models.find((m) => m.id === id)
      if (!model || !model.efforts.includes(effort)) return {}
      const forkEffortByModel = { ...s.forkEffortByModel, [model.id]: effort }
      persistForkSelection(s.forkModelId, forkEffortByModel)
      return { forkEffortByModel }
    }),

  setElaboration: (level) => {
    if (!ELABORATION_LEVELS.includes(level)) return
    try {
      localStorage.setItem(ELABORATION_KEY, level)
    } catch {
      /* private mode — selection just won't persist */
    }
    set({ elaboration: level })
  },

  loadChats: async () => {
    set({ chatsLoading: true })
    try {
      const chats = await api.listChats()
      set({ chats, chatsLoading: false, error: null })
    } catch (err) {
      set({ chatsLoading: false, error: errorMessage(err) })
    }
  },

  retitleOnExit: async (chatId, keepalive = false) => {
    const targetId = chatId ?? get().activeChatId
    if (!targetId || !get().titleDirty[targetId]) return

    // Claim the refresh before starting it so pagehide + a navigation click do
    // not create two Luna calls for the same interaction.
    set((s) => {
      if (!s.titleDirty[targetId]) return {}
      const titleDirty = { ...s.titleDirty }
      delete titleDirty[targetId]
      return { titleDirty }
    })

    try {
      const result = await api.retitleChat(targetId, keepalive)
      set((s) => {
        const cached = s.byChat[targetId]
        return {
          chats: s.chats.map((chat) =>
            chat.id === targetId
              ? {
                  ...chat,
                  title: result.title,
                  updatedAt: result.changed ? Date.now() : chat.updatedAt,
                }
              : chat,
          ),
          byChat: cached
            ? {
                ...s.byChat,
                [targetId]: { ...cached, chat: { ...cached.chat, title: result.title } },
              }
            : s.byChat,
        }
      })
    } catch (err) {
      // Navigation remains instant. A failed refresh stays dirty so the next
      // exit can retry; page teardown may discard this state naturally.
      set((s) => ({ titleDirty: { ...s.titleDirty, [targetId]: true } }))
      if (!keepalive) console.error('[store] retitle on exit failed', err)
    }
  },

  newChat: async () => {
    // A draft is untouched and already on screen by construction — hand it back.
    const draftChatId = get().draftChatId
    if (draftChatId) return get().chats.find((c) => c.id === draftChatId) ?? null
    // Rapid clicks: the first create is still in flight, don't start a second.
    if (creatingChat) return null
    // Sitting in a blank chat from an earlier session? That *is* the new chat.
    const activeChatId = get().activeChatId
    if (activeChatId && isUntouched(get().byChat[activeChatId])) {
      set({ draftChatId: activeChatId })
      return get().chats.find((c) => c.id === activeChatId) ?? null
    }

    creatingChat = true
    try {
      const chat = await api.createChat()
      set((s) => ({
        chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
        draftChatId: chat.id,
        error: null,
      }))
      await get().openChat(chat.id)
      return chat
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    } finally {
      creatingChat = false
    }
  },

  discardDraft: () => {
    const draftChatId = get().draftChatId
    if (!draftChatId) return
    // Typed into after all — it graduated, just stop tracking it. (A draft that
    // hasn't finished loading is still blank: we created it empty a moment ago.)
    if (hasContent(get().byChat[draftChatId])) {
      set({ draftChatId: null })
      return
    }
    set((s) => {
      const byChat = { ...s.byChat }
      delete byChat[draftChatId]
      return { chats: s.chats.filter((c) => c.id !== draftChatId), byChat, draftChatId: null }
    })
    // Best effort: the row is already gone, and a stranded empty chat is harmless.
    void api.deleteChat(draftChatId).catch(() => {})
  },

  removeChat: async (chatId) => {
    const wasActive = get().activeChatId === chatId
    if (wasActive) {
      get().clearFollowUpAttachments()
      get().clearStagedUploads()
    }
    if (get().draftChatId === chatId) set({ draftChatId: null })
    // optimistic — the row disappears the instant you click.
    const snapshot = get().chats
    set((s) => {
      const byChat = { ...s.byChat }
      const titleDirty = { ...s.titleDirty }
      const drafts = { ...s.drafts }
      delete byChat[chatId]
      delete titleDirty[chatId]
      delete drafts[`${chatId}:main`]
      delete drafts[`${chatId}:fork`]
      return { chats: s.chats.filter((c) => c.id !== chatId), byChat, titleDirty, drafts }
    })
    if (wasActive) {
      disconnect()
      set({ activeChatId: null, forkOpen: false, connection: 'closed' })
    }
    try {
      await api.deleteChat(chatId)
    } catch (err) {
      set({ chats: snapshot, error: errorMessage(err) })
    }
  },

  openChat: async (chatId) => {
    // Leaving an untouched new chat for another one: it goes back up.
    if (get().draftChatId && get().draftChatId !== chatId) get().discardDraft()
    if (get().activeChatId === chatId && get().byChat[chatId]?.loaded) return
    const previousChatId = get().activeChatId
    if (previousChatId && previousChatId !== chatId) {
      get().clearFollowUpAttachments()
      get().clearStagedUploads()
      void get().retitleOnExit(previousChatId)
    }
    disconnect()
    rememberChat(chatId)

    const known = get().chats.find((c) => c.id === chatId)
    set((s) => ({
      activeChatId: chatId,
      forkOpen: false,
      connection: 'connecting',
      byChat: pruneChatCache({
        ...s.byChat,
        [chatId]: {
          ...(s.byChat[chatId] ??
            emptyChatState(
              known ?? { id: chatId, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now() },
            )),
          loading: true,
          error: null,
        },
      }),
    }))

    let snapshot: ChatSnapshot
    try {
      snapshot = await api.getChat(chatId)
    } catch (err) {
      set((s) => {
        const cs = s.byChat[chatId]
        if (!cs) return {}
        return {
          byChat: { ...s.byChat, [chatId]: { ...cs, loading: false, error: errorMessage(err) } },
          connection: 'closed' as SseStatus,
        }
      })
      return
    }

    if (get().activeChatId !== chatId) return // user moved on while we were fetching

    const cs = hydrate(snapshot)
    set((s) => ({
      byChat: pruneChatCache({ ...s.byChat, [chatId]: cs }),
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...snapshot.chat } : c)),
    }))

    disconnect() // guard against a racing openChat (React 18 StrictMode double-mount)
    connection = connectChatEvents({
      chatId,
      after: cs.lastSeq,
      onEvent: enqueueEvent,
      onStatus: (status) => {
        if (get().activeChatId === chatId) set({ connection: status })
      },
    })
  },

  closeChat: () => {
    void get().retitleOnExit()
    get().discardDraft()
    get().clearFollowUpAttachments()
    get().clearStagedUploads()
    disconnect()
    set({ activeChatId: null, forkOpen: false, connection: 'closed' })
  },

  sendMessage: async (thread, content, attachments = []) => {
    const trimmed = content.trim()
    const chatId = get().activeChatId
    if (!trimmed || !chatId) return
    const cs = get().byChat[chatId]
    if (!cs) return
    const hadInitialExchange = isAfterInitialExchange(cs)
    const context = thread === 'fork' ? attachments.slice(0, 6) : []
    // Uploaded files staged on the composer ride along with the next main send.
    const stagedSourceIds =
      thread === 'main'
        ? get()
            .stagedUploads.filter((u) => u.status === 'ready' && u.sourceId)
            .map((u) => u.sourceId!)
        : []

    const localId = uid('local-')
    const optimistic: Message = {
      id: localId,
      chatId,
      thread,
      role: 'user',
      content: trimmed,
      status: 'complete',
      ...(context.length ? { attachments: context } : {}),
      ...(stagedSourceIds.length ? { sourceIds: stagedSourceIds } : {}),
      createdAt: Date.now(),
    }
    set((s) => {
      const current = s.byChat[chatId]
      if (!current) return {}
      return {
        error: null,
        // Typed into — it's a real conversation now, not a discardable draft.
        draftChatId: s.draftChatId === chatId ? null : s.draftChatId,
        byChat: {
          ...s.byChat,
          [chatId]: {
            ...current,
            messages: { ...current.messages, [thread]: [...current.messages[thread], optimistic] },
          },
        },
      }
    })

    try {
      const { models, selectedModelId, effortByModel, forkModelId, forkEffortByModel, elaboration } =
        get()
      // The fork carries its own selection; untouched, it inherits the main pair.
      const resolvedId = thread === 'fork' ? (forkModelId ?? selectedModelId) : selectedModelId
      const model = models.find((m) => m.id === resolvedId)
      const resolvedEffort = (id: string, fallback: string) =>
        thread === 'fork'
          ? (forkEffortByModel[id] ?? effortByModel[id] ?? fallback)
          : (effortByModel[id] ?? fallback)
      const selection = {
        ...(model ? { model: model.id, effort: resolvedEffort(model.id, model.defaultEffort) } : {}),
        elaboration,
      }
      const { runId } = await api.sendMessage(
        chatId,
        trimmed,
        thread,
        selection,
        context,
        stagedSourceIds,
      )
      if (stagedSourceIds.length) {
        const sent = new Set(stagedSourceIds)
        set((s) => ({
          stagedUploads: s.stagedUploads.filter((u) => !u.sourceId || !sent.has(u.sourceId)),
        }))
      }
      set((s) => {
        const current = s.byChat[chatId]
        if (!current) return {}
        // A very fast run can fully stream over SSE before this response lands —
        // its terminal run.status must not be clobbered back to 'running'.
        const reduced = current.timelines[runId]?.status
        const finished = !!reduced && reduced !== 'running' && reduced !== 'awaiting_input'
        return {
          byChat: {
            ...s.byChat,
            [chatId]: {
              ...current,
              currentRunId: { ...current.currentRunId, [thread]: runId },
              activeRun: finished
                ? current.activeRun
                : {
                    ...current.activeRun,
                    [thread]: { id: runId, chatId, thread, status: 'running' },
                  },
              messages: {
                ...current.messages,
                [thread]: current.messages[thread].map((m) =>
                  m.id === localId ? { ...m, runId } : m,
                ),
              },
            },
          },
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, updatedAt: Date.now() } : c)),
          titleDirty: hadInitialExchange ? { ...s.titleDirty, [chatId]: true } : s.titleDirty,
        }
      })
      for (const attachment of context) removeFrameContext(attachment.id)
      if (context.length) {
        const sent = new Set(context.map((attachment) => attachment.id))
        set((s) => ({
          followUpAttachments: s.followUpAttachments.filter(
            (attachment) => !sent.has(attachment.id),
          ),
        }))
      }
    } catch (err) {
      set((s) => {
        const current = s.byChat[chatId]
        if (!current) return { error: errorMessage(err) }
        return {
          error: errorMessage(err),
          byChat: {
            ...s.byChat,
            [chatId]: {
              ...current,
              messages: {
                ...current.messages,
                [thread]: current.messages[thread].filter((m) => m.id !== localId),
              },
            },
          },
        }
      })
    }
  },

  applyEvent: (event) => get().applyEvents([event]),

  applyEvents: (events) => {
    if (!events.length) return
    const ctx: ReduceCtx = { hydrating: false, resetDuringHydration: new Set() }
    set((s) => {
      let byChat = s.byChat
      let chats = s.chats
      let providerAlert = s.providerAlert
      let changed = false

      for (const event of events) {
        if (event.type === 'provider.error') {
          const detail = event.data as ProviderErrorEvent
          providerAlert = { providerId: detail.providerId, message: detail.message }
          changed = true
          continue
        }
        const chatId = event.chatId || s.activeChatId
        if (!chatId) continue
        const cs = byChat[chatId]
        if (!cs) continue
        const nextCs = reduceEvent(cs, event, ctx)
        if (nextCs === cs) continue
        if (byChat === s.byChat) byChat = { ...s.byChat }
        byChat[chatId] = nextCs
        changed = true
        if (nextCs.chat.title !== cs.chat.title) {
          chats = chats.map((chat) =>
            chat.id === chatId
              ? { ...chat, title: nextCs.chat.title, updatedAt: Date.now() }
              : chat,
          )
        }
      }

      return changed ? { byChat, chats, providerAlert } : {}
    })
  },

  resolveInput: async (pendingInputId, value) => {
    const chatId = get().activeChatId
    if (!chatId) return
    const currentChat = get().byChat[chatId]
    const hadInitialExchange = !!currentChat && isAfterInitialExchange(currentChat)
    // Lock the chips in immediately; the server echoes input.resolved right after.
    set((s) => {
      const cs = s.byChat[chatId]
      if (!cs) return {}
      const mark = (list: InputRequest[]) =>
        list.map((r) => (r.id === pendingInputId ? { ...r, resolved: true, value } : r))
      return {
        byChat: {
          ...s.byChat,
          [chatId]: {
            ...cs,
            inputRequests: { main: mark(cs.inputRequests.main), fork: mark(cs.inputRequests.fork) },
            pendingInput: cs.pendingInput?.id === pendingInputId ? null : cs.pendingInput,
          },
        },
      }
    })
    try {
      await api.resolveInput(chatId, pendingInputId, value)
      if (hadInitialExchange) {
        set((s) => ({ titleDirty: { ...s.titleDirty, [chatId]: true } }))
      }
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  stopRun: async (thread) => {
    const chatId = get().activeChatId
    if (!chatId) return
    try {
      // lib/api's stopRun has no thread param — post the scoped body from here.
      // No thread means stop everything running in the chat (the old behavior).
      const res = await fetch(`${api.API_BASE}/chats/${encodeURIComponent(chatId)}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(thread ? { thread } : {}),
      })
      if (!res.ok) {
        let message = res.statusText || `Request failed (${res.status})`
        const body: unknown = await res.json().catch(() => undefined)
        if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
          message = body.error
        }
        throw new api.ApiError(res.status, message, body)
      }
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  setForkOpen: (open) => set({ forkOpen: open }),
  toggleFork: () => set((s) => ({ forkOpen: !s.forkOpen })),

  focusForkAttachment: (attachmentId) =>
    set((s) => {
      const cs = activeChatState(s)
      const message = cs?.messages.fork.find((m) =>
        m.attachments?.some((attachment) => attachment.id === attachmentId),
      )
      // Even without a resolvable message the panel still opens on the thread.
      if (!message) return { forkOpen: true }
      return {
        forkOpen: true,
        forkFocus: { messageId: message.id, nonce: (s.forkFocus?.nonce ?? 0) + 1 },
      }
    }),

  clearForkFocus: () => set((s) => (s.forkFocus ? { forkFocus: null } : {})),

  addFollowUpAttachment: (attachment) => {
    const current = get().followUpAttachments
    if (current.some((item) => item.id === attachment.id)) {
      set({ forkOpen: true })
      return
    }
    if (current.length >= 6) {
      removeFrameContext(attachment.id)
      set({
        forkOpen: true,
        error: 'You can attach up to 6 selections to one follow-up.',
      })
      return
    }
    set((s) => {
      const nextNumber =
        s.followUpAttachments.reduce((max, item) => {
          if (item.kind !== attachment.kind) return max
          const value = Number.parseInt(item.label.split(' ').at(-1) ?? '', 10)
          return Number.isFinite(value) ? Math.max(max, value) : max
        }, 0) + 1
      return {
        forkOpen: true,
        error: null,
        followUpAttachments: [
          ...s.followUpAttachments,
          { ...attachment, label: `${attachment.kind} ${nextNumber}` },
        ],
      }
    })
  },

  removeFollowUpAttachment: (id) => {
    removeFrameContext(id)
    set((s) => ({
      followUpAttachments: s.followUpAttachments.filter((attachment) => attachment.id !== id),
    }))
  },

  clearFollowUpAttachments: () => {
    for (const attachment of get().followUpAttachments) removeFrameContext(attachment.id)
    set({ followUpAttachments: [] })
  },

  setDraft: (chatId, thread, value) =>
    set((s) => {
      const key = `${chatId}:${thread}`
      const drafts = { ...s.drafts }
      if (value) drafts[key] = value
      else delete drafts[key]
      return { drafts }
    }),

  getDraft: (chatId, thread) => get().drafts[`${chatId}:${thread}`] ?? '',

  attachFiles: async (files) => {
    const chatId = get().activeChatId
    if (!chatId || !files.length) return

    const patchStaged = (localId: string, patch: Partial<StagedUpload>) =>
      set((s) => ({
        stagedUploads: s.stagedUploads.map((u) => (u.localId === localId ? { ...u, ...patch } : u)),
      }))

    // One request per file: per-file progress, and one bad file can't sink the rest.
    await Promise.all(
      files.map(async (file) => {
        const localId = uid('upload-')
        set((s) => ({
          stagedUploads: [
            ...s.stagedUploads,
            { localId, name: file.name, size: file.size, status: 'uploading', progress: 0 },
          ],
        }))
        try {
          const result = await api.uploadSources(chatId, [file], (progress) =>
            patchStaged(localId, { progress }),
          )
          const source = result.sources[0]
          if (source) {
            patchStaged(localId, { status: 'ready', progress: 1, sourceId: source.id })
          } else {
            patchStaged(localId, {
              status: 'error',
              error: result.rejected[0]?.error ?? 'Upload rejected',
            })
          }
        } catch (err) {
          patchStaged(localId, { status: 'error', error: errorMessage(err) })
        }
      }),
    )
  },

  removeStagedUpload: (localId) => {
    const staged = get().stagedUploads.find((u) => u.localId === localId)
    if (staged?.sourceId) {
      // Unstaging before sending withdraws the file from local sources too.
      void api.deleteSource(staged.sourceId).catch(() => {})
    }
    set((s) => ({ stagedUploads: s.stagedUploads.filter((u) => u.localId !== localId) }))
  },

  clearStagedUploads: () => set({ stagedUploads: [] }),

  removeSource: async (sourceId) => {
    // The optimistic path: source.removed comes back over SSE, but pulling it
    // out immediately keeps the panel snappy.
    set(patchActive((cs) => ({ ...cs, sources: cs.sources.filter((s) => s.id !== sourceId) })))
    set((s) => ({ stagedUploads: s.stagedUploads.filter((u) => u.sourceId !== sourceId) }))
    try {
      await api.deleteSource(sourceId)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  setHistoryOpen: (open) => set(patchActive((cs) => (cs.historyOpen === open ? cs : { ...cs, historyOpen: open }))),

  toggleHistory: () => set(patchActive((cs) => ({ ...cs, historyOpen: !cs.historyOpen }))),

  selectAsset: (assetId) =>
    set(
      patchActive((cs) =>
        cs.selectedAssetId === assetId && !cs.historyOpen
          ? cs
          : { ...cs, selectedAssetId: assetId, historyOpen: false },
      ),
    ),

  clearBloom: () => set(patchActive((cs) => (cs.bloom ? { ...cs, bloom: false } : cs))),

  dismissSheet: (messageId) =>
    set(
      patchActive((cs) =>
        cs.dismissedSheets[messageId]
          ? cs
          : { ...cs, dismissedSheets: { ...cs.dismissedSheets, [messageId]: true } },
      ),
    ),

  setTheme: (theme) => {
    applyThemeToDom(theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* private mode — theme just won't persist */
    }
    set({ theme })
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  dismissError: () => set({ error: null }),
  dismissProviderAlert: () => set({ providerAlert: null }),
}))

export const useRautmlStore = useStore

function errorMessage(err: unknown): string {
  if (err instanceof api.ApiError) {
    if (err.isConflict) return 'A response is already running in this thread.'
    if (err.status === 0) return 'Cannot reach the server.'
    return err.message
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

/* --------------------------------------------------------------- selectors */

const EMPTY_MESSAGES: Message[] = []
const EMPTY_ASSETS: Asset[] = []
const EMPTY_WIDGETS: string[] = []
const EMPTY_ASSET_IDS: string[] = []
const EMPTY_FILES: PresentedFile[] = []
const EMPTY_INPUTS: InputRequest[] = []

export function activeChatState(state: StoreState): ChatState | null {
  return state.activeChatId ? (state.byChat[state.activeChatId] ?? null) : null
}

export const useChats = () => useStore((s) => s.chats)

/** The open chat is a blank one — "New chat" has nothing left to create. */
export const useOnBlankChat = () =>
  useStore((s) => !!s.activeChatId && isUntouched(s.byChat[s.activeChatId]))

export const useActiveChatId = () => useStore((s) => s.activeChatId)
export const useActiveChat = () => useStore(activeChatState)
export const useChatMeta = () => useStore((s) => activeChatState(s)?.chat ?? null)
export const useChatLoading = () => useStore((s) => activeChatState(s)?.loading ?? false)

export const useMessages = (thread: Thread = 'main') =>
  useStore((s) => activeChatState(s)?.messages[thread] ?? EMPTY_MESSAGES)

export const useTimelines = () => useStore((s) => activeChatState(s)?.timelines ?? EMPTY_TIMELINES)
const EMPTY_TIMELINES: Record<string, RunTimeline> = {}

export const useTimeline = (runId?: string) =>
  useStore((s) => (runId ? (activeChatState(s)?.timelines[runId] ?? null) : null))

export const useAssets = () => useStore((s) => activeChatState(s)?.assets ?? EMPTY_ASSETS)

export const useAsset = (assetId?: string) =>
  useStore((s) => (assetId ? (activeChatState(s)?.assets.find((a) => a.id === assetId) ?? null) : null))

export const useAssetIdsForMessage = (messageId: string) =>
  useStore((s) => activeChatState(s)?.assetsByMessage[messageId] ?? EMPTY_ASSET_IDS)

export const useWidgets = (messageId: string) =>
  useStore((s) => activeChatState(s)?.widgets[messageId] ?? EMPTY_WIDGETS)

export const usePresentedFiles = (messageId: string) =>
  useStore((s) => activeChatState(s)?.files[messageId] ?? EMPTY_FILES)

const EMPTY_SOURCES: Source[] = []

/** Every file in the active chat's local sources, oldest first. */
export const useSources = () => useStore((s) => activeChatState(s)?.sources ?? EMPTY_SOURCES)

export const useStagedUploads = () => useStore((s) => s.stagedUploads)

export const useInputRequests = (thread: Thread = 'main') =>
  useStore((s) => activeChatState(s)?.inputRequests[thread] ?? EMPTY_INPUTS)

export const usePendingInput = () => useStore((s) => activeChatState(s)?.pendingInput ?? null)

export const useActiveRun = (thread: Thread = 'main') =>
  useStore((s) => activeChatState(s)?.activeRun[thread] ?? null)

export const useIsRunning = (thread: Thread = 'main') =>
  useStore((s) => {
    const run = activeChatState(s)?.activeRun[thread]
    return !!run && isLive(run.status)
  })

/* ------------------------------------------------------- document mode */

/**
 * True when the open chat should hand the main column to the document.
 *
 * Deferred while the *initial* build is still running: if every asset so far
 * belongs to the live main run, keep the chat + activity timeline on stage so
 * tool calls stay visible during first HTML creation. Takeover (and bloom)
 * happens when that run finishes. Follow-up edits already in document mode
 * stay there — older assets mean `allFromLive` is false.
 */
export const useDocumentMode = () =>
  useStore((s) => {
    const cs = activeChatState(s)
    if (!cs || cs.assets.length === 0) return false
    const run = cs.activeRun.main
    if (run && isLive(run.status)) {
      const liveMsgIds = new Set(
        cs.messages.main.filter((m) => m.runId === run.id).map((m) => m.id),
      )
      const allFromLive = cs.assets.every((a) => !!a.messageId && liveMsgIds.has(a.messageId))
      if (allFromLive) return false
    }
    return true
  })

export const useHistoryOpen = () => useStore((s) => activeChatState(s)?.historyOpen ?? false)

export const useSelectedAssetId = () =>
  useStore((s) => {
    const cs = activeChatState(s)
    if (!cs || cs.assets.length === 0) return null
    if (cs.selectedAssetId && cs.assets.some((a) => a.id === cs.selectedAssetId)) {
      return cs.selectedAssetId
    }
    return assetsNewestFirst(cs.assets)[0]?.id ?? null
  })

/** The asset currently on stage (newest by default). */
export const useSelectedAsset = () => {
  const id = useSelectedAssetId()
  return useAsset(id ?? undefined)
}

export const useBloom = () => useStore((s) => activeChatState(s)?.bloom ?? false)

export const useSheetDismissed = (messageId: string | null | undefined) =>
  useStore((s) => (messageId ? !!activeChatState(s)?.dismissedSheets[messageId] : false))

/* ------------------------------------------------------- model selection */

export const useModels = () => useStore((s) => s.models)
export const useEnabledModels = () => {
  const models = useStore((s) => s.models)
  const providers = useStore((s) => s.providers)
  const enabledModelIds = useStore((s) => s.enabledModelIds)
  return useMemo(() => {
    const enabled = new Set(enabledModelIds)
    const selectable = selectableModelIds(models, providers)
    return models.filter((model) => enabled.has(model.id) && selectable.has(model.id))
  }, [models, providers, enabledModelIds])
}
export const useProviders = () => useStore((s) => s.providers)

export const useSelectedModel = () =>
  useStore((s) => s.models.find((m) => m.id === s.selectedModelId) ?? s.models[0] ?? null)

/** The effort in force for the selected model (its provider default until changed). */
export const useSelectedEffort = () =>
  useStore((s) => {
    const model = s.models.find((m) => m.id === s.selectedModelId) ?? s.models[0]
    if (!model) return null
    const remembered = s.effortByModel[model.id]
    return remembered && model.efforts.includes(remembered) ? remembered : model.defaultEffort
  })

/** The fork's model — its own override, or the main selection until one is made. */
export const useForkSelectedModel = () =>
  useStore(
    (s) =>
      s.models.find((m) => m.id === (s.forkModelId ?? s.selectedModelId)) ?? s.models[0] ?? null,
  )

/** The effort in force for the fork's model: fork dial, else main dial, else default. */
export const useForkSelectedEffort = () =>
  useStore((s) => {
    const model =
      s.models.find((m) => m.id === (s.forkModelId ?? s.selectedModelId)) ?? s.models[0]
    if (!model) return null
    const remembered = s.forkEffortByModel[model.id] ?? s.effortByModel[model.id]
    return remembered && model.efforts.includes(remembered) ? remembered : model.defaultEffort
  })

export const useElaboration = () => useStore((s) => s.elaboration)

export const useTheme = () => useStore((s) => s.theme)
export const useForkOpen = () => useStore((s) => s.forkOpen)
export const useForkFocus = () => useStore((s) => s.forkFocus)

const EMPTY_MARKS: QuestionedMark[] = []

/**
 * Every selection of this asset that was already sent with a fork question,
 * in thread order — what the asset frames render as underlines/note badges.
 */
export const useQuestionedMarks = (assetId: string | undefined): QuestionedMark[] => {
  const messages = useMessages('fork')
  // Marks derive only from the attachments on fork user messages, but a
  // message.delta rebuilds the list identity every token. Key the memo on the
  // attachment content (ids + versions + asset ids) so the returned array keeps
  // its identity unless the marks themselves actually change — the frames diff
  // and re-mark on identity, and attachments are immutable once sent.
  const marksKey = useMemo(() => {
    if (!assetId) return ''
    const parts: string[] = []
    for (const message of messages) {
      if (message.role !== 'user' || !message.attachments) continue
      for (const attachment of message.attachments) {
        if (attachment.assetId !== assetId) continue
        parts.push(`${attachment.id}:${attachment.version}:${attachment.assetId}`)
      }
    }
    return parts.join('|')
  }, [messages, assetId])
  return useMemo(() => {
    if (!assetId) return EMPTY_MARKS
    const marks: QuestionedMark[] = []
    for (const message of messages) {
      if (message.role !== 'user' || !message.attachments) continue
      for (const attachment of message.attachments) {
        if (attachment.assetId !== assetId) continue
        marks.push({ id: attachment.id, kind: attachment.kind, content: attachment.content })
      }
    }
    return marks.length ? marks : EMPTY_MARKS
    // `messages` is intentionally keyed through marksKey: when the key is
    // unchanged the computed marks are content-identical too.
  }, [marksKey, assetId])
}
export const useFollowUpAttachments = () => useStore((s) => s.followUpAttachments)
export const useConnection = () => useStore((s) => s.connection)
export const useStoreError = () => useStore((s) => s.error)
export const useProviderAlert = () => useStore((s) => s.providerAlert)

/* ---------------------------------------------------------------- settings */

export const useSettingsOpen = () => useStore((s) => s.settingsOpen)
export const useSettingsSection = () => useStore((s) => s.settingsSection)
export const useApiKeys = () => useStore((s) => s.apiKeys)
export const usePersonalization = () => useStore((s) => s.personalization)
export const useSettingsError = () => useStore((s) => s.settingsError)
export const useSettingsSaving = (field: string) => useStore((s) => Boolean(s.settingsSaving[field]))
