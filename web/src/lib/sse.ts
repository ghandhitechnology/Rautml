/* EventSource wrapper for GET /api/chats/:id/events?after=<seq>.
 *
 * - Tracks the highest seq seen and always reconnects with ?after=<lastSeq>, so a drop
 *   replays exactly the missed events (server persists every event in tool_events).
 * - Exponential backoff with jitter (400ms → 10s), reset on a healthy connection.
 * - Drops out-of-order / duplicate events (seq <= lastSeq) so replay is idempotent.
 * - Handles both server conventions: a default `message` frame carrying the whole
 *   ChatEvent JSON, or a named SSE event (`event: tool.start`) with the payload.
 */

import { eventsUrl } from './api'
import { CHAT_EVENT_TYPES, type ChatEvent } from './types'

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SseOptions {
  chatId: string
  /** Resume point — last seq already applied (0 = from the beginning). */
  after?: number
  onEvent: (event: ChatEvent) => void
  onStatus?: (status: SseStatus) => void
}

export interface SseConnection {
  readonly chatId: string
  /** Highest seq applied so far. */
  lastSeq(): number
  /** Force an immediate reconnect (e.g. window regained focus). */
  reconnect(): void
  close(): void
}

const BASE_DELAY = 400
const MAX_DELAY = 10_000
/**
 * Consecutive failures before fast retries give way to a probed slow cadence:
 * a permanently-failing endpoint (the chat was deleted server-side and the
 * route 404s) must not storm every ≤10s forever behind a "Reconnecting…"
 * badge, but a transient outage longer than this budget must not leave the
 * stream closed either. Past the budget we probe the endpoint (see
 * probeAndSchedule): definitive 4xx → closed; anything else → keep retrying
 * slowly so a recovered server resumes the chat without a focus/reopen nudge.
 * A successful open or a manual reconnect() resets the count.
 */
const MAX_ATTEMPTS = 8
/** Retry interval once the fast budget is exhausted (transient outage). */
const SLOW_RETRY_DELAY = 30_000

export function connectChatEvents(opts: SseOptions): SseConnection {
  const { chatId, onEvent, onStatus } = opts

  let lastSeq = opts.after ?? 0
  let attempt = 0
  let closed = false
  let source: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const status = (s: SseStatus) => onStatus?.(s)

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const teardown = () => {
    clearTimer()
    if (source) {
      source.onopen = null
      source.onerror = null
      source.onmessage = null
      source.close()
      source = null
    }
  }

  const handleFrame = (raw: string, fallbackType?: string) => {
    if (!raw) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return

    const obj = parsed as Record<string, unknown>
    // Named-event convention: payload may be just the `data` object.
    const type = typeof obj.type === 'string' ? obj.type : fallbackType
    if (!type) return

    const hasEnvelope = 'seq' in obj || 'data' in obj
    const event: ChatEvent = {
      seq: typeof obj.seq === 'number' ? obj.seq : lastSeq + 1,
      chatId: typeof obj.chatId === 'string' ? obj.chatId : chatId,
      thread: obj.thread === 'fork' ? 'fork' : 'main',
      type,
      data: hasEnvelope ? (obj.data ?? {}) : obj,
      at: typeof obj.at === 'number' ? obj.at : Date.now(),
    }

    if (event.seq <= lastSeq) return // already applied (replay overlap)
    lastSeq = event.seq
    onEvent(event)
  }

  /**
   * EventSource errors carry no HTTP status, so past the fast-retry budget we
   * probe the endpoint once to tell a dead route (chat deleted → 4xx, close
   * for good) from a transient outage (network error / 5xx → keep retrying on
   * a slow cadence; a healthy 200 means the last error was spurious, so
   * reconnect right away).
   */
  const probeAndSchedule = async () => {
    try {
      const res = await fetch(eventsUrl(chatId, lastSeq), {
        signal: AbortSignal.timeout(MAX_DELAY),
      })
      await res.body?.cancel().catch(() => {})
      if (closed) return
      if (res.status >= 400 && res.status < 500) {
        // Terminal from the user's perspective: the stream is dead, not
        // reconnecting — reconnect() still works from here.
        status('closed')
        return
      }
      if (res.ok) {
        open()
        return
      }
    } catch {
      if (closed) return
    }
    status('reconnecting')
    timer = setTimeout(open, SLOW_RETRY_DELAY)
  }

  const open = () => {
    if (closed) return
    teardown()
    status(attempt === 0 ? 'connecting' : 'reconnecting')

    const es = new EventSource(eventsUrl(chatId, lastSeq))
    source = es

    es.onopen = () => {
      attempt = 0
      status('open')
    }

    es.onmessage = (ev: MessageEvent<string>) => handleFrame(ev.data)

    for (const name of CHAT_EVENT_TYPES) {
      es.addEventListener(name, (ev) => handleFrame((ev as MessageEvent<string>).data, name))
    }

    es.onerror = () => {
      if (closed) return
      // Own the retry loop so we can resume with ?after=<lastSeq>.
      teardown()
      if (attempt >= MAX_ATTEMPTS) {
        void probeAndSchedule()
        return
      }
      const delay = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY)
      const jittered = delay * (0.75 + Math.random() * 0.5)
      attempt += 1
      status('reconnecting')
      timer = setTimeout(open, jittered)
    }
  }

  open()

  return {
    chatId,
    lastSeq: () => lastSeq,
    reconnect: () => {
      if (closed) return
      attempt = 0
      open()
    },
    close: () => {
      closed = true
      teardown()
      status('closed')
    },
  }
}
