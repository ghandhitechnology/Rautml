// The agentic run loop (CONTRACT.md § Engine).
//
// startRun()  — persists the user turn, creates a run, then detaches the loop.
// resumeRun() — re-enters a loop that parked on `ask_user_input_v0`.
// stopRun()   — aborts every live run for a chat (and cancels parked ones).
//
// Everything the loop needs to continue lives in SQLite (`model_turns`), so a
// parked run survives a server restart; only in-flight streaming does not.

import path from 'node:path';
import { db, WORKSPACES_DIR } from '../db.js';
import * as repo from '../repo.js';
import * as sse from '../sse.js';
import { buildToolRegistry } from '../tools/index.js';
import type { PendingInput, Thread, ToolCtx, ToolDef } from '../types.js';
import {
  nonStreaming,
  streamChat,
  type ChatMessage,
  type OpenRouterTool,
} from './openrouter.js';
import { FORK_PREAMBLE, SYSTEM_PROMPT, TITLE_SYSTEM_PROMPT } from './prompts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on tool calls per run; hitting it injects a wrap-up nudge. */
const MAX_TOOL_CALLS = 40;
/** Tool results longer than this are truncated in the middle. */
const TOOL_RESULT_MAX = 24_000;
/** Safety valve on model round-trips (each may carry several tool calls). */
const MAX_ITERATIONS = 64;

const WRAP_UP_NUDGE =
  'You have reached this run\'s tool-call budget. Stop calling tools now and write your final answer using what you already have. If something is incomplete, say so briefly and offer to continue.';

const FRIENDLY_ERROR =
  '⚠️ 응답을 생성하는 중 문제가 발생했어요. 다시 시도해 주세요.\n\n⚠️ Something went wrong while generating this response. Please try again.';

// ---------------------------------------------------------------------------
// Live run registry (for stopRun)
// ---------------------------------------------------------------------------

interface LiveRun {
  chatId: string;
  thread: Thread;
  controller: AbortController;
}

const activeRuns = new Map<string, LiveRun>();

class AbortedError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { name?: string }).name === 'AbortError' ||
      (err as { code?: string }).code === 'ABORT_ERR')
  );
}

// ---------------------------------------------------------------------------
// pending_inputs access
// ---------------------------------------------------------------------------
// repo.ts owns all other SQL, but it exposes no by-id lookup carrying
// run_id / thread / the parked tool_call_id — which is exactly what resumeRun
// needs. These two statements are additive reads/writes against the unchanged
// schema; the payload stays JSON-compatible with repo.getUnresolvedInput().

interface PendingInputRow {
  id: string;
  runId: string;
  chatId: string;
  thread: Thread;
  question: string;
  options: string[];
  toolCallId: string;
  resolved: boolean;
}

function persistPendingInput(input: {
  runId: string;
  chatId: string;
  thread: Thread;
  question: string;
  options: string[];
  toolCallId: string;
}): PendingInput {
  const pending = repo.createPendingInput({
    runId: input.runId,
    chatId: input.chatId,
    thread: input.thread,
    question: input.question,
    options: input.options,
  });
  const payload = JSON.stringify({
    question: input.question,
    options: input.options,
    toolCallId: input.toolCallId,
  });
  db.prepare(`UPDATE pending_inputs SET payload = ? WHERE id = ?`).run(payload, pending.id);
  return pending;
}

function loadPendingInput(id: string): PendingInputRow | undefined {
  const row = db.prepare(`SELECT * FROM pending_inputs WHERE id = ?`).get(id) as any;
  if (!row) return undefined;
  let parsed: any = {};
  try {
    parsed = JSON.parse(row.payload ?? '{}');
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    runId: row.run_id,
    chatId: row.chat_id,
    thread: (row.thread as Thread) ?? 'main',
    question: typeof parsed.question === 'string' ? parsed.question : '',
    options: Array.isArray(parsed.options) ? parsed.options.map(String) : [],
    toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : '',
    resolved: !!row.resolved,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function emit(chatId: string, thread: Thread, type: string, data: any): void {
  sse.publish(chatId, thread, type, data);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function truncateMiddle(text: string, max = TOOL_RESULT_MAX): string {
  if (text.length <= max) return text;
  const marker = '\n\n[…truncated…]\n\n';
  const half = Math.floor((max - marker.length) / 2);
  return text.slice(0, half) + marker + text.slice(text.length - half);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function hostOf(url: unknown): string {
  const raw = str(url);
  try {
    return new URL(raw).host;
  } catch {
    return clip(raw, 60);
  }
}

function baseName(p: unknown): string {
  const raw = str(p);
  const parts = raw.split('/');
  return parts[parts.length - 1] || raw;
}

function isAssetPath(p: unknown): boolean {
  return /^\/?assets\/[^/]+\.html$/i.test(str(p));
}

/** Human-readable label for the tool.start event. */
function toolLabel(name: string, args: any): string {
  switch (name) {
    case 'web_search':
      return `Searching: “${clip(str(args?.query), 70)}”`;
    case 'image_search':
      return `Finding images: “${clip(str(args?.query), 70)}”`;
    case 'web_fetch':
      return `Reading: ${hostOf(args?.url)}`;
    case 'bash_tool':
      return `Running: ${clip(str(args?.command), 70)}`;
    case 'create_file':
      return isAssetPath(args?.path)
        ? `Building: ${baseName(args?.path)}`
        : `Writing: ${clip(str(args?.path), 60)}`;
    case 'str_replace':
      return isAssetPath(args?.path)
        ? `Editing: ${baseName(args?.path)}`
        : `Editing: ${clip(str(args?.path), 60)}`;
    case 'view':
      return `Viewing: ${clip(str(args?.path), 60)}`;
    case 'present_files': {
      const n = Array.isArray(args?.paths) ? args.paths.length : 0;
      return n ? `Preparing ${n} file${n === 1 ? '' : 's'}` : 'Preparing files';
    }
    case 'visualize_read_me':
      return 'Reading the design guide';
    case 'visualize_show_widget':
      return 'Drawing a visual';
    case 'ask_user_input_v0':
      return `Asking: “${clip(str(args?.question), 70)}”`;
    default:
      return name.replace(/_/g, ' ');
  }
}

/** Short status text for the tool.end event. */
function toolSummary(name: string, result: string, ok: boolean): string {
  if (!ok) return clip(result, 160) || 'Failed';
  if (name === 'web_search' || name === 'image_search') {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) return `${parsed.length} result${parsed.length === 1 ? '' : 's'}`;
      if (Array.isArray(parsed?.results)) {
        return `${parsed.results.length} result${parsed.results.length === 1 ? '' : 's'}`;
      }
    } catch {
      /* fall through to generic summary */
    }
  }
  if (name === 'web_fetch') return `${result.length.toLocaleString('en-US')} chars`;
  if (name === 'visualize_read_me') return 'Design constraints loaded';
  const firstLine = result.split('\n').find((l) => l.trim().length > 0) ?? '';
  return clip(firstLine, 140) || 'Done';
}

function toOpenRouterTool(def: ToolDef): OpenRouterTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

function parseArgs(raw: string): { ok: true; args: any } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, args: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch (err) {
    return { ok: false, error: `Invalid JSON arguments: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * Guarantees every assistant turn that requested tools is followed by a result
 * for each tool_call_id. A run that was stopped mid-batch (or parked) would
 * otherwise produce a 400 from the API.
 */
function sanitizeTurns(turns: any[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn || typeof turn !== 'object' || typeof turn.role !== 'string') continue;

    if (turn.role === 'assistant' && Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0) {
      out.push({
        role: 'assistant',
        content: typeof turn.content === 'string' ? turn.content : '',
        tool_calls: turn.tool_calls,
      });
      const missing = new Set<string>(turn.tool_calls.map((c: any) => String(c?.id ?? '')));
      let j = i + 1;
      while (j < turns.length && turns[j]?.role === 'tool') {
        const t = turns[j];
        out.push({
          role: 'tool',
          tool_call_id: String(t.tool_call_id ?? ''),
          content: typeof t.content === 'string' ? t.content : '',
        });
        missing.delete(String(t.tool_call_id ?? ''));
        j++;
      }
      for (const id of missing) {
        if (!id) continue;
        out.push({ role: 'tool', tool_call_id: id, content: '(no result — the run was interrupted)' });
      }
      i = j - 1;
      continue;
    }

    if (turn.role === 'tool') {
      // Orphan tool result (shouldn't happen) — drop it rather than 400.
      continue;
    }

    out.push({
      role: turn.role as ChatMessage['role'],
      content: typeof turn.content === 'string' ? turn.content : '',
    });
  }
  return out;
}

/**
 * main → system prompt + all main turns.
 * fork → system prompt + fork preamble, then all main turns, then all fork turns.
 */
function buildContext(chatId: string, thread: Thread): ChatMessage[] {
  const system =
    thread === 'fork' ? `${SYSTEM_PROMPT}\n\n---\n\n${FORK_PREAMBLE}` : SYSTEM_PROMPT;
  const turns =
    thread === 'fork'
      ? [...repo.listModelTurns(chatId, 'main'), ...repo.listModelTurns(chatId, 'fork')]
      : repo.listModelTurns(chatId, 'main');
  return [{ role: 'system', content: system }, ...sanitizeTurns(turns)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persists the user message + model turn, creates the run, emits run.status,
 * then fires the agentic loop **detached**. Resolves as soon as setup is done
 * so an HTTP handler can return `{ runId }` immediately.
 */
export async function startRun(
  chatId: string,
  thread: Thread,
  userContent: string,
): Promise<{ runId: string }> {
  repo.insertMessage({ chatId, thread, role: 'user', content: userContent, status: 'complete' });
  repo.appendModelTurn(chatId, thread, { role: 'user', content: userContent });
  repo.touchChat(chatId);

  const run = repo.createRun(chatId, thread);
  emit(chatId, thread, 'run.status', { runId: run.id, status: 'running' });

  const controller = new AbortController();
  activeRuns.set(run.id, { chatId, thread, controller });

  // Detached on purpose: survives client disconnect; SSE replay covers reload.
  void runLoop({ chatId, thread, runId: run.id, controller, toolCallCount: 0 }).catch((err) => {
    console.error('[engine] unhandled run failure', err);
  });

  return { runId: run.id };
}

/**
 * Resumes a run parked by `ask_user_input_v0`: appends the answer as the tool
 * result for the parked call and re-enters the loop (detached).
 */
export async function resumeRun(
  pendingInputId: string,
  value: string,
): Promise<{ runId: string } | null> {
  const pending = loadPendingInput(pendingInputId);
  if (!pending || pending.resolved) return null;

  const run = repo.getRun(pending.runId);
  if (!run || (run.status !== 'awaiting_input' && run.status !== 'running')) return null;

  repo.resolvePendingInput(pendingInputId, value);
  emit(pending.chatId, pending.thread, 'input.resolved', { pendingInputId, value });

  if (pending.toolCallId) {
    repo.appendModelTurn(pending.chatId, pending.thread, {
      role: 'tool',
      tool_call_id: pending.toolCallId,
      content: value,
    });
  } else {
    repo.appendModelTurn(pending.chatId, pending.thread, { role: 'user', content: value });
  }

  repo.setRunStatus(pending.runId, 'running');
  emit(pending.chatId, pending.thread, 'run.status', { runId: pending.runId, status: 'running' });
  repo.touchChat(pending.chatId);

  const controller = new AbortController();
  activeRuns.set(pending.runId, {
    chatId: pending.chatId,
    thread: pending.thread,
    controller,
  });

  void runLoop({
    chatId: pending.chatId,
    thread: pending.thread,
    runId: pending.runId,
    controller,
    toolCallCount: 0,
  }).catch((err) => {
    console.error('[engine] unhandled resume failure', err);
  });

  return { runId: pending.runId };
}

/** Aborts every live run for a chat and cancels any run parked on user input. */
export function stopRun(chatId: string): { stopped: string[] } {
  const stopped: string[] = [];

  for (const [runId, live] of activeRuns) {
    if (live.chatId !== chatId) continue;
    live.controller.abort();
    stopped.push(runId);
  }

  // Parked runs have no live controller — finalise them straight from the DB.
  for (const thread of ['main', 'fork'] as Thread[]) {
    const run = repo.getActiveRun(chatId, thread);
    if (!run || activeRuns.has(run.id)) continue;
    repo.setRunStatus(run.id, 'stopped');
    emit(chatId, thread, 'run.status', { runId: run.id, status: 'stopped' });
    stopped.push(run.id);
  }

  return { stopped };
}

/** True while a run for this chat is streaming in this process. */
export function isRunLive(runId: string): boolean {
  return activeRuns.has(runId);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface LoopCtx {
  chatId: string;
  thread: Thread;
  runId: string;
  controller: AbortController;
  toolCallCount: number;
}

async function runLoop(ctx: LoopCtx): Promise<void> {
  const { chatId, thread, runId, controller } = ctx;

  const registry: ToolDef[] = buildToolRegistry();
  const toolsByName = new Map(registry.map((t) => [t.name, t]));
  const wireTools = registry.map(toOpenRouterTool);
  const workspaceDir = path.join(WORKSPACES_DIR, chatId);

  // The assistant message currently being written, if any. Non-null here means
  // it is still 'streaming' and must be finalised before we leave.
  let liveMessageId: string | null = null;
  let liveText = '';

  let parked = false;
  let nudged = false;
  let completedFirstAnswer = false;

  const openMessage = (): string => {
    if (liveMessageId) return liveMessageId;
    const message = repo.insertMessage({
      chatId,
      thread,
      role: 'assistant',
      content: '',
      status: 'streaming',
      runId,
    });
    liveMessageId = message.id;
    liveText = '';
    emit(chatId, thread, 'message.start', { messageId: message.id, role: 'assistant' });
    return message.id;
  };

  const closeMessage = (content: string, status: 'complete' | 'error' = 'complete') => {
    if (!liveMessageId) return;
    const id = liveMessageId;
    liveMessageId = null;
    repo.updateMessageContent(id, content);
    repo.updateMessageStatus(id, status);
    emit(chatId, thread, 'message.complete', { messageId: id, content });
  };

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (controller.signal.aborted) throw new AbortedError();

      const messages = buildContext(chatId, thread);

      const result = await streamChat({
        messages,
        tools: wireTools.length > 0 ? wireTools : undefined,
        // After the wrap-up nudge, deny tools so the model must answer.
        toolChoice: nudged ? 'none' : 'auto',
        signal: controller.signal,
        onText: (delta) => {
          const id = openMessage();
          liveText += delta;
          emit(chatId, thread, 'message.delta', { messageId: id, text: delta });
        },
      });

      const hasToolCalls = result.toolCalls.length > 0;

      // Tools need a host message: assets, widgets and presented files attach to
      // it, and the activity timeline renders underneath it.
      if (hasToolCalls) openMessage();
      // Captured before closeMessage() clears it — assets/widgets/files emitted
      // by the tools below attach to this message.
      const hostMessageId = liveMessageId ?? '';

      // Canonical transcript entry for this model turn.
      const assistantTurn: ChatMessage = { role: 'assistant', content: result.content ?? '' };
      if (hasToolCalls) assistantTurn.tool_calls = result.toolCalls;
      repo.appendModelTurn(chatId, thread, assistantTurn);

      if (!hasToolCalls) {
        const finalText = liveText.trim().length > 0 ? liveText : result.content ?? '';
        closeMessage(finalText);
        if (finalText.trim().length > 0) completedFirstAnswer = true;
        break;
      }

      // Tool calls follow: keep this assistant message *open* so text produced
      // after the tools run appends to the same bubble. Closing per iteration
      // would leave one empty assistant message behind for every tool round.
      // Content is flushed to the DB so a mid-run reload sees what's there.
      if (liveMessageId) repo.updateMessageContent(liveMessageId, liveText);

      // --- execute tool calls -------------------------------------------------
      const toolCtx: ToolCtx = {
        chatId,
        runId,
        thread,
        workspaceDir,
        messageId: hostMessageId,
        emit: (type: string, data: any) => emit(chatId, thread, type, data),
      };

      let pausedAt = -1;

      for (let c = 0; c < result.toolCalls.length; c++) {
        const call = result.toolCalls[c];
        if (controller.signal.aborted) throw new AbortedError();

        const name = call.function.name;
        const parsed = parseArgs(call.function.arguments);
        const args = parsed.ok ? parsed.args : {};

        emit(chatId, thread, 'tool.start', {
          toolCallId: call.id,
          name,
          label: toolLabel(name, args),
        });

        // --- ask_user_input_v0: park the whole run ---------------------------
        if (name === 'ask_user_input_v0' && parsed.ok) {
          const question = str(args.question) || 'Which option should I take?';
          const options = Array.isArray(args.options) ? args.options.map(String) : [];
          const pending = persistPendingInput({
            runId,
            chatId,
            thread,
            question,
            options,
            toolCallId: call.id,
          });

          emit(chatId, thread, 'input.request', {
            pendingInputId: pending.id,
            question,
            options,
          });
          emit(chatId, thread, 'tool.end', {
            toolCallId: call.id,
            name,
            ok: true,
            summary: 'Waiting for your answer',
          });

          pausedAt = c;
          break;
        }

        let ok = true;
        let output = '';

        if (!parsed.ok) {
          ok = false;
          output = parsed.error;
        } else {
          const def = toolsByName.get(name);
          if (!def) {
            ok = false;
            output = `Unknown tool: ${name}`;
          } else {
            try {
              output = (await def.execute(args, toolCtx)) ?? '';
            } catch (err) {
              if (isAbort(err)) throw err;
              ok = false;
              output = `Error: ${(err as Error)?.message ?? String(err)}`;
            }
          }
        }

        const stored = truncateMiddle(str(output));
        emit(chatId, thread, 'tool.end', {
          toolCallId: call.id,
          name,
          ok,
          summary: toolSummary(name, stored, ok),
        });
        repo.appendModelTurn(chatId, thread, {
          role: 'tool',
          tool_call_id: call.id,
          content: stored,
        });
        ctx.toolCallCount += 1;
      }

      if (pausedAt >= 0) {
        // Any calls batched after the question never ran — close them out so the
        // transcript stays valid, then park.
        for (let c = pausedAt + 1; c < result.toolCalls.length; c++) {
          const skipped = result.toolCalls[c];
          repo.appendModelTurn(chatId, thread, {
            role: 'tool',
            tool_call_id: skipped.id,
            content: '(not executed — the run paused to ask the user a question)',
          });
        }
        repo.setRunStatus(runId, 'awaiting_input');
        emit(chatId, thread, 'run.status', { runId, status: 'awaiting_input' });
        activeRuns.delete(runId);
        parked = true;
        return;
      }

      if (ctx.toolCallCount >= MAX_TOOL_CALLS && !nudged) {
        repo.appendModelTurn(chatId, thread, { role: 'user', content: WRAP_UP_NUDGE });
        nudged = true;
      }
    }

    closeMessage(liveText);
    repo.setRunStatus(runId, 'done');
    emit(chatId, thread, 'run.status', { runId, status: 'done' });
    repo.touchChat(chatId);

    if (thread === 'main' && completedFirstAnswer) {
      await maybeAutoTitle(chatId, thread);
    }
  } catch (err) {
    if (isAbort(err) || controller.signal.aborted) {
      closeMessage(liveText);
      repo.setRunStatus(runId, 'stopped');
      emit(chatId, thread, 'run.status', { runId, status: 'stopped' });
    } else {
      const detail = (err as Error)?.message ?? String(err);
      console.error('[engine] run error', runId, detail);
      const body = liveText.trim().length > 0 ? `${liveText}\n\n${FRIENDLY_ERROR}` : FRIENDLY_ERROR;
      if (!liveMessageId) openMessage();
      closeMessage(body, 'error');
      repo.setRunStatus(runId, 'error', detail);
      emit(chatId, thread, 'run.status', { runId, status: 'error', error: clip(detail, 300) });
    }
    repo.touchChat(chatId);
  } finally {
    // A parked run keeps its DB status; it just has no live controller.
    if (!parked) activeRuns.delete(runId);
    // Belt and braces: nothing may be left in 'streaming'.
    if (liveMessageId) closeMessage(liveText);
  }
}

// ---------------------------------------------------------------------------
// Auto-title
// ---------------------------------------------------------------------------

async function maybeAutoTitle(chatId: string, thread: Thread): Promise<void> {
  try {
    const chat = repo.getChat(chatId);
    if (!chat || (chat.title && chat.title !== 'New chat')) return;

    const messages = repo.listMessages(chatId, 'main');
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return;
    const firstAssistant = messages.find(
      (m) => m.role === 'assistant' && m.content.trim().length > 0,
    );

    const sample = [
      `User: ${clip(firstUser.content, 900)}`,
      firstAssistant ? `Assistant: ${clip(firstAssistant.content, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const raw = await nonStreaming(
      [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: sample },
      ],
      // gpt-5.6-sol spends completion tokens on reasoning before it emits any
      // text; a 32-token budget gets consumed entirely by it (finish_reason
      // 'length', empty content) and the chat silently stays "New chat".
      { maxTokens: 256, temperature: 0.3 },
    );

    const firstLine = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
    const title = clip(firstLine.replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, ''), 60);
    if (!title) return;

    repo.setChatTitle(chatId, title);
    emit(chatId, thread, 'chat.title', { title });
  } catch (err) {
    console.error('[engine] auto-title failed', (err as Error)?.message ?? err);
  }
}
