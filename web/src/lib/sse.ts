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
 * Consecutive failures before we stop retrying: a permanently-failing
 * endpoint (the chat was deleted server-side and the route 404s) must not
 * storm every ≤10s forever behind a "Reconnecting…" badge. A successful open
 * or a manual reconnect() (window focus, reopening the chat) resets the count.
 */
const MAX_ATTEMPTS = 8

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
        // Terminal from the user's perspective: the stream is dead, not
        // reconnecting — reconnect() still works from here.
        status('closed')
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
