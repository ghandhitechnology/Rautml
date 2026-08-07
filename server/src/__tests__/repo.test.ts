import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from '../db.js';
import * as repo from '../repo.js';
import * as sse from '../sse.js';

// NOTE: test files run in parallel processes against the shared dev database,
// so global-sweep counts (reapStaleRuns) are asserted with >=, never exactly.

describe('boot reaper', () => {
  it('errors stranded running runs + streaming messages, spares parked runs', () => {
    const chat = repo.createChat();
    try {
      const running = repo.createRun(chat.id, 'main');
      const parked = repo.createRun(chat.id, 'fork');
      repo.setRunStatus(parked.id, 'awaiting_input');
      const streaming = repo.insertMessage({
        chatId: chat.id,
        thread: 'main',
        role: 'assistant',
        content: 'partial text',
        status: 'streaming',
        runId: running.id,
      });
      const complete = repo.insertMessage({
        chatId: chat.id,
        thread: 'main',
        role: 'assistant',
        content: 'finished',
        status: 'complete',
      });

      const reaped = repo.reapStaleRuns();
      assert.ok(reaped.runs >= 1);
      assert.ok(reaped.messages >= 1);

      assert.equal(repo.getRun(running.id)?.status, 'error');
      // A parked run survives reboots by design — never reaped.
      assert.equal(repo.getRun(parked.id)?.status, 'awaiting_input');

      const messages = repo.listMessages(chat.id, 'main');
      const reapedMessage = messages.find((m) => m.id === streaming.id);
      assert.equal(reapedMessage?.status, 'error');
      // Partial content is kept.
      assert.equal(reapedMessage?.content, 'partial text');
      assert.equal(messages.find((m) => m.id === complete.id)?.status, 'complete');
    } finally {
      repo.deleteChat(chat.id);
    }
  });
});

describe('pending inputs', () => {
  it('persists the parked tool_call_id in a single write', () => {
    const chat = repo.createChat();
    try {
      const run = repo.createRun(chat.id, 'main');
      const pending = repo.createPendingInput({
        runId: run.id,
        chatId: chat.id,
        thread: 'main',
        question: 'Which way?',
        options: ['a', 'b'],
        toolCallId: 'call_123',
      });
      const row = repo.getPendingInput(pending.id);
      assert.equal(row?.runId, run.id);
      assert.equal(row?.thread, 'main');
      assert.equal(row?.question, 'Which way?');
      assert.deepEqual(row?.options, ['a', 'b']);
      assert.equal(row?.toolCallId, 'call_123');
      assert.equal(row?.resolved, false);

      // The ux.ts fallback path (no toolCallId) keeps working.
      const fallback = repo.createPendingInput({
        runId: run.id,
        chatId: chat.id,
        thread: 'main',
        question: 'Fallback?',
        options: [],
      });
      assert.equal(repo.getPendingInput(fallback.id)?.toolCallId, '');
    } finally {
      repo.deleteChat(chat.id);
    }
  });

  it('resolves only the stopped run’s unanswered questions', () => {
    const chat = repo.createChat();
    try {
      const runA = repo.createRun(chat.id, 'main');
      const runB = repo.createRun(chat.id, 'fork');
      const a1 = repo.createPendingInput({
        runId: runA.id,
        chatId: chat.id,
        thread: 'main',
        question: 'q1',
        options: ['x'],
      });
      const a2 = repo.createPendingInput({
        runId: runA.id,
        chatId: chat.id,
        thread: 'main',
        question: 'q2',
        options: ['y'],
      });
      const b1 = repo.createPendingInput({
        runId: runB.id,
        chatId: chat.id,
        thread: 'fork',
        question: 'q3',
        options: ['z'],
      });
      repo.resolvePendingInput(a2.id, 'answered already');

      const resolved = repo.resolvePendingInputsForRun(runA.id);
      assert.deepEqual(resolved, [a1.id]);
      assert.equal(repo.getPendingInput(a1.id)?.resolved, true);
      assert.equal(repo.getPendingInput(b1.id)?.resolved, false);
      // Idempotent: nothing left to clear.
      assert.deepEqual(repo.resolvePendingInputsForRun(runA.id), []);
    } finally {
      repo.deleteChat(chat.id);
    }
  });
});

describe('corrupt-row tolerance', () => {
  it('skips unparseable model_turns and tool_events rows instead of throwing', () => {
    const chat = repo.createChat();
    try {
      repo.appendModelTurn(chat.id, 'main', { role: 'user', content: 'good' });
      db.prepare(`INSERT INTO model_turns (chat_id, thread, seq, json) VALUES (?, ?, ?, ?)`).run(
        chat.id,
        'main',
        2,
        '{corrupt',
      );
      const turns = repo.listModelTurns(chat.id, 'main');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].content, 'good');
      assert.equal(repo.listModelTurnsUpTo(chat.id, 'main', 10).length, 1);

      sse.publish(chat.id, 'main', 'run.status', { runId: 'r1', status: 'running' });
      db.prepare(
        `INSERT INTO tool_events (chat_id, run_id, seq, type, payload, created_at) VALUES (?, NULL, ?, ?, ?, ?)`,
      ).run(chat.id, 99, 'broken', '{corrupt', Date.now());
      const events = repo.listEventsAfter(chat.id, 0);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'run.status');

      // The corrupt rows are still skipped (not deleted) on chat teardown.
    } finally {
      repo.deleteChat(chat.id);
    }
  });
});

describe('SSE delta coalescing', () => {
  it('flushes buffered deltas before a different event, keeping seq order', () => {
    const chat = repo.createChat();
    try {
      sse.publish(chat.id, 'main', 'message.delta', { messageId: 'm1', text: 'Hello' });
      sse.publish(chat.id, 'main', 'message.delta', { messageId: 'm1', text: ' ' });
      sse.publish(chat.id, 'main', 'message.delta', { messageId: 'm1', text: 'world' });
      // Nothing persisted yet — the deltas are buffered.
      assert.equal(repo.listEventsAfter(chat.id, 0).length, 0);

      // A non-delta event flushes the buffer first so it can't be overtaken.
      sse.publish(chat.id, 'main', 'message.complete', { messageId: 'm1', content: 'Hello world' });
      const events = repo.listEventsAfter(chat.id, 0);
      assert.equal(events.length, 2);
      assert.equal(events[0]!.type, 'message.delta');
      assert.equal(events[0]!.data.text, 'Hello world');
      assert.equal(events[0]!.data.messageId, 'm1');
      assert.equal(events[1]!.type, 'message.complete');
      assert.ok(events[0]!.seq < events[1]!.seq);
    } finally {
      repo.deleteChat(chat.id);
    }
  });

  it('keeps targets separate and flushes on the timer', async () => {
    const chat = repo.createChat();
    try {
      sse.publish(chat.id, 'main', 'thinking.delta', { thinkingId: 't1', text: 'a' });
      sse.publish(chat.id, 'main', 'thinking.delta', { thinkingId: 't1', text: 'b' });
      sse.publish(chat.id, 'main', 'message.delta', { messageId: 'm1', text: '1' });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const events = repo.listEventsAfter(chat.id, 0);
      assert.equal(events.length, 2);
      const thinking = events.find((e) => e.type === 'thinking.delta');
      const message = events.find((e) => e.type === 'message.delta');
      assert.equal(thinking?.data.text, 'ab');
      assert.equal(message?.data.text, '1');
      // First-delta order decides the flush order, seqs stay monotonic.
      assert.ok(thinking!.seq < message!.seq);
    } finally {
      repo.deleteChat(chat.id);
    }
  });
});
