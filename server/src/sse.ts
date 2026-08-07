// SSE hub: subscribe(chatId, res) + publish(chatId, thread, type, data).
// Persistence (seq assignment) happens via repo; live subscribers get pushed
// the same event immediately. Replay of events with seq > ?after is the
// caller's job (routes/api.ts calls repo.listEventsAfter before subscribing).
import type { Response } from 'express';
import * as repo from './repo.js';
import type { Thread } from './types.js';

const HEARTBEAT_MS = 25_000;
/** Consecutive deltas for the same target merge into one row this often. */
const DELTA_FLUSH_MS = 250;

const subscribers = new Map<string, Set<Response>>();

// ---------------------------------------------------------------------------
// Delta coalescing
// ---------------------------------------------------------------------------
// message.delta / thinking.delta stream per token, and every publish used to
// cost one tool_events row. Consecutive deltas for the same target (messageId
// / thinkingId) are buffered and flushed as a single event — when a different
// event arrives for the chat, or after DELTA_FLUSH_MS. The seq is assigned and
// the live push made at flush time, so a subscriber connecting mid-buffer
// (backlog read, then subscribe — one synchronous block in routes/api.ts) can
// never hit a gap or a duplicate: what wasn't flushed yet arrives live with a
// later seq. There is deliberately no flush on subscribe: pushing live frames
// to the just-registered subscriber would put higher seqs on the wire before
// the route's backlog frames, and the client drops out-of-order seqs.

interface PendingDelta {
  thread: Thread;
  type: string;
  /** The first delta's data; its `text` grows as later deltas merge in. */
  data: any;
  timer: ReturnType<typeof setTimeout>;
}

// key: `${chatId}:${type}:${target}`
const pendingDeltas = new Map<string, PendingDelta>();

function deltaTarget(type: string, data: any): string | null {
  if (type === 'message.delta') return typeof data?.messageId === 'string' ? data.messageId : null;
  if (type === 'thinking.delta') return typeof data?.thinkingId === 'string' ? data.thinkingId : null;
  return null;
}

/** Persists the event (assigning its seq) and pushes it to live subscribers. */
function deliver(chatId: string, thread: Thread, type: string, data: any): void {
  const event = repo.insertEvent(chatId, thread, type, data);
  const set = subscribers.get(chatId);
  if (!set || set.size === 0) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    let ok = false;
    try {
      ok = res.write(line);
    } catch {
      /* a dead socket is treated like backpressure below */
    }
    // A write that fails or returns false means the client can't keep up
    // live — drop it; it replays whatever it missed via ?after= on reconnect.
    if (!ok) {
      set.delete(res);
      res.destroy();
    }
  }
  if (set.size === 0) subscribers.delete(chatId);
}

function flushDelta(chatId: string, key: string): void {
  const pending = pendingDeltas.get(key);
  if (!pending) return;
  pendingDeltas.delete(key);
  clearTimeout(pending.timer);
  deliver(chatId, pending.thread, pending.type, pending.data);
}

/** Flushes every buffered delta of a chat, in first-delta order. */
function flushChatDeltas(chatId: string): void {
  for (const key of [...pendingDeltas.keys()]) {
    if (key.startsWith(`${chatId}:`)) flushDelta(chatId, key);
  }
}

export function subscribe(chatId: string, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  let set = subscribers.get(chatId);
  if (!set) {
    set = new Set();
    subscribers.set(chatId, set);
  }
  set.add(res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    set?.delete(res);
    if (set && set.size === 0) subscribers.delete(chatId);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
}

export function publish(chatId: string, thread: Thread, type: string, data: any): void {
  const target = deltaTarget(type, data);
  if (target) {
    const key = `${chatId}:${type}:${target}`;
    const pending = pendingDeltas.get(key);
    if (pending) {
      pending.data = {
        ...pending.data,
        text: String(pending.data.text ?? '') + String(data?.text ?? ''),
      };
      return;
    }
    const timer = setTimeout(() => flushDelta(chatId, key), DELTA_FLUSH_MS);
    // Buffered deltas must never keep the process alive on shutdown.
    timer.unref?.();
    pendingDeltas.set(key, { thread, type, data: { ...data }, timer });
    return;
  }
  // A non-delta event must not overtake the deltas that logically precede it.
  flushChatDeltas(chatId);
  deliver(chatId, thread, type, data);
}
