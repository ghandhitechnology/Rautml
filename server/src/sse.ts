// SSE hub: subscribe(chatId, res) + publish(chatId, thread, type, data).
// Persistence (seq assignment) happens via repo; live subscribers get pushed
// the same event immediately. Replay of events with seq > ?after is the
// caller's job (routes/api.ts calls repo.listEventsAfter before subscribing).
import type { Response } from 'express';
import * as repo from './repo.js';
import type { Thread } from './types.js';

const HEARTBEAT_MS = 25_000;

const subscribers = new Map<string, Set<Response>>();

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
  const event = repo.insertEvent(chatId, thread, type, data);
  const set = subscribers.get(chatId);
  if (!set || set.size === 0) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    res.write(line);
  }
}
