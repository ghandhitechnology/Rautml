/* Rautml store (zustand).
 *
 * One store for the whole app: the chat list, the open chat's full state (both threads),
 * live run timelines keyed by runId, assets, pending input, plus UI bits (theme, fork panel).
 * `applyEvent` is the single reducer for every SSE event type in CONTRACT.md.
 */

import { create } from 'zustand'
import * as api from '../lib/api'
import { connectChatEvents, type SseConnection, type SseStatus } from '../lib/sse'
import { uid } from '../lib/utils'
import type {
  Asset,
  AssetCreatedEvent,
  ElaborationLevel,
  AssetVersionEvent,
  Chat,
  ChatEvent,
  ChatSnapshot,
  ChatTitleEvent,
  FilesPresentedEvent,
  InputRequest,
  InputRequestEvent,
  InputResolvedEvent,
  Message,
  MessageCompleteEvent,
  MessageDeltaEvent,
  MessageStartEvent,
  ModelInfo,
  PendingInput,
  PresentedFile,
  Run,
  RunStatusEvent,
  RunTimeline,
  ThemeName,
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
  connection: SseStatus
  error: string | null

  /* actions */
  loadModels: () => Promise<void>
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
  sendMessage: (thread: Thread, content: string) => Promise<void>
  applyEvent: (event: ChatEvent) => void
  resolveInput: (pendingInputId: string, value: string) => Promise<void>
  stopRun: () => Promise<void>
  setForkOpen: (open: boolean) => void
  toggleFork: () => void
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
      next = patchTimeline(next, runId, (t) =>
        t.items.some((i) => i.toolCallId === d.toolCallId)
          ? t
          : {
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
            },
      )
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

/** Guards against a double-click racing two POST /api/chats before either lands. */
let creatingChat = false

function disconnect() {
  connection?.close()
  connection = null
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
  selectedModelId: readStoredModel(),
  effortByModel: readStoredEfforts(),
  forkModelId: readStoredModel(FORK_MODEL_KEY),
  forkEffortByModel: readStoredEfforts(FORK_EFFORT_KEY),
  elaboration: readStoredElaboration(),

  theme: typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light',
  forkOpen: false,
  connection: 'closed',
  error: null,

  loadModels: async () => {
    try {
      const { models, defaultModelId } = await api.listModels()
      set((s) => {
        // Stale localStorage (a model removed from the catalog) falls back to the default.
        const stored = s.selectedModelId
        const selectedModelId =
          stored && models.some((m) => m.id === stored) ? stored : defaultModelId
        // Drop remembered efforts that the provider no longer offers.
        const effortByModel: Record<string, string> = {}
        for (const m of models) {
          const remembered = s.effortByModel[m.id]
          if (remembered && m.efforts.includes(remembered)) effortByModel[m.id] = remembered
        }
        // Same hygiene for the fork override; a stale model falls back to inherit.
        const forkModelId =
          s.forkModelId && models.some((m) => m.id === s.forkModelId) ? s.forkModelId : null
        const forkEffortByModel: Record<string, string> = {}
        for (const m of models) {
          const remembered = s.forkEffortByModel[m.id]
          if (remembered && m.efforts.includes(remembered)) forkEffortByModel[m.id] = remembered
        }
        persistSelection(selectedModelId, effortByModel)
        persistForkSelection(forkModelId, forkEffortByModel)
        return { models, selectedModelId, effortByModel, forkModelId, forkEffortByModel }
      })
    } catch (err) {
      // The composer falls back to the server-side default model; not fatal.
      console.error('[store] loadModels failed', err)
    }
  },

  setModel: (modelId) =>
    set((s) => {
      if (!s.models.some((m) => m.id === modelId)) return {}
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
      if (!s.models.some((m) => m.id === modelId)) return {}
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
    if (get().draftChatId === chatId) set({ draftChatId: null })
    // optimistic — the row disappears the instant you click.
    const snapshot = get().chats
    set((s) => {
      const byChat = { ...s.byChat }
      const titleDirty = { ...s.titleDirty }
      delete byChat[chatId]
      delete titleDirty[chatId]
      return { chats: s.chats.filter((c) => c.id !== chatId), byChat, titleDirty }
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
      void get().retitleOnExit(previousChatId)
    }
    disconnect()

    const known = get().chats.find((c) => c.id === chatId)
    set((s) => ({
      activeChatId: chatId,
      forkOpen: false,
      connection: 'connecting',
      byChat: {
        ...s.byChat,
        [chatId]: {
          ...(s.byChat[chatId] ??
            emptyChatState(
              known ?? { id: chatId, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now() },
            )),
          loading: true,
          error: null,
        },
      },
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
      byChat: { ...s.byChat, [chatId]: cs },
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...snapshot.chat } : c)),
    }))

    disconnect() // guard against a racing openChat (React 18 StrictMode double-mount)
    connection = connectChatEvents({
      chatId,
      after: cs.lastSeq,
      onEvent: (event) => get().applyEvent(event),
      onStatus: (status) => {
        if (get().activeChatId === chatId) set({ connection: status })
      },
    })
  },

  closeChat: () => {
    void get().retitleOnExit()
    get().discardDraft()
    disconnect()
    set({ activeChatId: null, forkOpen: false, connection: 'closed' })
  },

  sendMessage: async (thread, content) => {
    const trimmed = content.trim()
    const chatId = get().activeChatId
    if (!trimmed || !chatId) return
    const cs = get().byChat[chatId]
    if (!cs) return
    const hadInitialExchange = isAfterInitialExchange(cs)

    const localId = uid('local-')
    const optimistic: Message = {
      id: localId,
      chatId,
      thread,
      role: 'user',
      content: trimmed,
      status: 'complete',
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
      const { runId } = await api.sendMessage(chatId, trimmed, thread, selection)
      set((s) => {
        const current = s.byChat[chatId]
        if (!current) return {}
        return {
          byChat: {
            ...s.byChat,
            [chatId]: {
              ...current,
              currentRunId: { ...current.currentRunId, [thread]: runId },
              activeRun: {
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

  applyEvent: (event) => {
    const chatId = event.chatId || get().activeChatId
    if (!chatId) return
    const ctx: ReduceCtx = { hydrating: false, resetDuringHydration: new Set() }
    set((s) => {
      const cs = s.byChat[chatId]
      if (!cs) return {}
      const nextCs = reduceEvent(cs, event, ctx)
      if (nextCs === cs) return {}
      const patch: Partial<StoreState> = { byChat: { ...s.byChat, [chatId]: nextCs } }
      if (nextCs.chat.title !== cs.chat.title) {
        patch.chats = s.chats.map((c) =>
          c.id === chatId ? { ...c, title: nextCs.chat.title, updatedAt: Date.now() } : c,
        )
      }
      return patch
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

  stopRun: async () => {
    const chatId = get().activeChatId
    if (!chatId) return
    try {
      await api.stopRun(chatId)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  setForkOpen: (open) => set({ forkOpen: open }),
  toggleFork: () => set((s) => ({ forkOpen: !s.forkOpen })),

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
  useStore((s) => activeChatState(s)?.assetsByMessage[messageId] ?? EMPTY_WIDGETS)

export const useWidgets = (messageId: string) =>
  useStore((s) => activeChatState(s)?.widgets[messageId] ?? EMPTY_WIDGETS)

export const usePresentedFiles = (messageId: string) =>
  useStore((s) => activeChatState(s)?.files[messageId] ?? EMPTY_FILES)

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
export const useConnection = () => useStore((s) => s.connection)
export const useStoreError = () => useStore((s) => s.error)
