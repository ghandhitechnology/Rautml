// ChatGPT Codex backend provider.
//
// Rautml's OpenAI models (openai/gpt-5.6-*) can run on the user's ChatGPT
// subscription instead of OpenRouter, using the OAuth credentials the Codex
// CLI keeps in ~/.codex/auth.json. This module speaks the Responses API the
// Codex backend expects and adapts it to the same streamChat/nonStreaming
// contract as openrouter.ts, so callers cannot tell the providers apart.
//
// Wire notes (probed 2026-08 against codex-cli 0.146.0 credentials):
//   - POST https://chatgpt.com/backend-api/codex/responses, SSE only.
//   - Auth: Bearer access_token + chatgpt-account-id header. Tokens refresh
//     via auth.openai.com; refreshed tokens are written back to auth.json
//     (the same thing the Codex CLI does).
//   - `max_output_tokens` and `temperature` are rejected — both are omitted.
//   - reasoning.effort passes through (none…max verified).

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  NonStreamingOptions,
  StreamChatOptions,
  StreamResult,
  ToolCall,
  ToolChoice,
  OpenRouterTool,
} from './openrouter.js';

/** Override to point at a proxy or a local mock (tests use this). */
const ENDPOINT =
  process.env.CODEX_RESPONSES_URL ?? 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
/** The Codex CLI's public OAuth client id (PKCE — not a secret). */
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 600;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
/** Refresh the access token when it has less than this much life left. */
const TOKEN_SLACK_MS = 5 * 60_000;

function authPath(): string {
  const home = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  return path.join(home, 'auth.json');
}

// ---------------------------------------------------------------------------
// Errors (mirrors OpenRouterError so both providers retry identically)
// ---------------------------------------------------------------------------

export class CodexError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable: boolean }) {
    super(message);
    this.name = 'CodexError';
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

class AbortedError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { name?: string }).name === 'AbortError' ||
      (err as { code?: string }).code === 'ABORT_ERR')
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Auth: load, refresh, persist
// ---------------------------------------------------------------------------

interface CodexTokens {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
}

let cachedAuth: CodexAuthFile | null | undefined;
let refreshing: Promise<CodexTokens> | null = null;

function readAuthFile(): CodexAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), 'utf8')) as CodexAuthFile;
    return parsed?.tokens?.access_token && parsed.tokens.refresh_token ? parsed : null;
  } catch {
    return null;
  }
}

/** True when Codex CLI credentials exist on this machine (`codex login`). */
export function codexAvailable(): boolean {
  if (cachedAuth === undefined) cachedAuth = readAuthFile();
  return !!cachedAuth;
}

function jwtExpMs(token: string): number {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function refreshTokens(auth: CodexAuthFile): Promise<CodexTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: auth.tokens!.refresh_token,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // A dead refresh token needs a human (`codex login`); retrying won't help.
    throw new CodexError(
      `Codex OAuth refresh failed (${res.status}): ${text.slice(0, 300) || res.statusText}. Run \`codex login\` and try again.`,
      { status: res.status, retryable: false },
    );
  }
  const json: any = await res.json();
  const tokens: CodexTokens = {
    id_token: json.id_token ?? auth.tokens!.id_token,
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? auth.tokens!.refresh_token,
    account_id: auth.tokens!.account_id,
  };
  const next: CodexAuthFile = { ...auth, tokens, last_refresh: new Date().toISOString() };
  try {
    writeFileSync(authPath(), JSON.stringify(next, null, 2));
  } catch {
    // Persisting is best-effort; the in-memory tokens still work this process.
  }
  cachedAuth = next;
  return tokens;
}

/** Valid access token + account id, refreshing (serialized) when near expiry. */
async function getTokens(force = false): Promise<CodexTokens> {
  cachedAuth = cachedAuth === undefined ? readAuthFile() : cachedAuth;
  const auth = cachedAuth;
  if (!auth?.tokens) {
    throw new CodexError('No Codex credentials (~/.codex/auth.json). Run `codex login`.', {
      retryable: false,
    });
  }
  const fresh = jwtExpMs(auth.tokens.access_token) - Date.now() > TOKEN_SLACK_MS;
  if (fresh && !force) return auth.tokens;
  refreshing ??= refreshTokens(auth).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// ---------------------------------------------------------------------------
// chat.completions → Responses API translation
// ---------------------------------------------------------------------------

/** `openai/gpt-5.6-sol` → `gpt-5.6-sol` (the id the Codex backend expects). */
export function toCodexModel(model: string): string {
  return model.startsWith('openai/') ? model.slice('openai/'.length) : model;
}

function toInput(messages: ChatMessage[]): { instructions: string; input: any[] } {
  const systems: string[] = [];
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systems.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: m.content ?? '',
      });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        });
      }
      for (const call of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          name: call.function.name,
          arguments: call.function.arguments,
          call_id: call.id,
        });
      }
      continue;
    }
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: m.content ?? '' }],
    });
  }
  return { instructions: systems.join('\n\n'), input };
}

function toResponsesTools(tools: OpenRouterTool[] | undefined): any[] {
  return (tools ?? []).map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    strict: false,
    parameters: t.function.parameters,
  }));
}

function buildBody(
  messages: ChatMessage[],
  tools: OpenRouterTool[] | undefined,
  toolChoice: ToolChoice,
  model: string,
  reasoningEffort?: string,
  /** Ask for reasoning summaries (what the Codex CLI itself sends). */
  wantSummary = true,
): Record<string, unknown> {
  const { instructions, input } = toInput(messages);
  const body: Record<string, unknown> = {
    model: toCodexModel(model),
    instructions,
    input,
    tools: toResponsesTools(tools),
    tool_choice: toolChoice,
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
  // Summaries are the only readable signal during a long reasoning stretch, so
  // they are requested even when no explicit effort was chosen.
  const reasoning: Record<string, unknown> = {};
  if (reasoningEffort) reasoning.effort = reasoningEffort;
  if (wantSummary) reasoning.summary = 'auto';
  if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
  return body;
}

/** A 400 blaming the reasoning.summary field — retry once without asking for it. */
function rejectsSummary(err: unknown): boolean {
  return (
    err instanceof CodexError && err.status === 400 && /summary/i.test(err.message)
  );
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

async function postResponses(body: unknown, tokens: CodexTokens, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.146.0',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        session_id: randomUUID(),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new CodexError(`network error: ${(err as Error).message}`, { retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CodexError(`Codex backend ${res.status}: ${text.slice(0, 500) || res.statusText}`, {
      status: res.status,
      // 401 is retryable: the retry loop force-refreshes the token first.
      retryable: res.status === 401 || res.status === 429 || res.status === 408 || res.status >= 500,
    });
  }
  return res;
}

async function readSse(res: Response, onEvent: (ev: any) => void): Promise<void> {
  const body = res.body;
  if (!body) throw new CodexError('empty response body', { retryable: true });

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleBlock = (block: string) => {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return true;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        /* keep-alive / partial frame */
      }
    }
    return false;
  };

  try {
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () =>
            reject(
              new CodexError(`stream stalled for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`, {
                retryable: true,
              }),
            ),
          STREAM_IDLE_TIMEOUT_MS,
        );
      });
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(idleTimer);
      }
      const { done, value } = read;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (handleBlock(block)) return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock?.();
  }
}

// ---------------------------------------------------------------------------
// Public API (same contract as openrouter.ts)
// ---------------------------------------------------------------------------

export async function codexStreamChat(options: StreamChatOptions): Promise<StreamResult> {
  const {
    messages,
    tools,
    toolChoice = 'auto',
    signal,
    onText,
    onReasoning,
    onStreamOpen,
    onToolCallStart,
    onRetry,
    model,
    reasoningEffort,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;
  if (!model) throw new CodexError('codexStreamChat requires an explicit model', { retryable: false });

  let wantSummary = true;
  let body = buildBody(messages, tools, toolChoice, model, reasoningEffort, wantSummary);

  let lastError: unknown;
  let forceRefresh = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw new AbortedError();

    let emittedText = false;
    let content = '';
    const toolCalls: ToolCall[] = [];
    const announced = new Set<string>();
    let completed = false;
    let failure: string | null = null;

    try {
      const tokens = await getTokens(forceRefresh);
      forceRefresh = false;
      const res = await postResponses(body, tokens, signal);
      onStreamOpen?.();

      await readSse(res, (ev) => {
        const type: string = typeof ev?.type === 'string' ? ev.type : '';
        // Reasoning arrives as summary text, raw reasoning text, or (on newer
        // backends) a variant of both — anything reasoning-shaped counts.
        if (type.includes('reasoning') && type.endsWith('.delta')) {
          const delta = typeof ev.delta === 'string' ? ev.delta : '';
          if (delta) onReasoning?.(delta);
          return;
        }
        switch (type) {
          case 'response.output_text.delta': {
            const delta = typeof ev.delta === 'string' ? ev.delta : '';
            if (!delta) break;
            content += delta;
            emittedText = true;
            onText?.(delta);
            break;
          }
          case 'response.output_item.added': {
            const item = ev.item;
            if (item?.type === 'function_call' && item.call_id && !announced.has(item.call_id)) {
              announced.add(item.call_id);
              onToolCallStart?.({ id: item.call_id, name: item.name ?? '' });
            }
            break;
          }
          case 'response.output_item.done': {
            const item = ev.item;
            if (item?.type === 'function_call') {
              toolCalls.push({
                id: item.call_id ?? `call_${toolCalls.length}`,
                type: 'function',
                function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
              });
            }
            break;
          }
          case 'response.completed':
            completed = true;
            break;
          case 'response.failed':
          case 'error':
            failure = JSON.stringify(ev.response?.error ?? ev.error ?? ev).slice(0, 300);
            break;
          default:
            break;
        }
      });

      if (failure) throw new CodexError(`Codex backend failure: ${failure}`, { retryable: true });
      // No completed event means the connection dropped mid-response.
      if (!completed && toolCalls.length === 0 && content.length === 0) {
        throw new CodexError('stream ended unexpectedly (no response.completed)', {
          retryable: true,
        });
      }

      return {
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;

      // The backend doesn't want reasoning summaries — drop them and retry.
      // Costs one attempt at most; every later call in this process still asks.
      if (wantSummary && rejectsSummary(err)) {
        wantSummary = false;
        body = buildBody(messages, tools, toolChoice, model, reasoningEffort, false);
        attempt -= 1;
        continue;
      }

      const codexErr = err instanceof CodexError ? err : null;
      const retryable = codexErr ? codexErr.retryable : true;
      if (codexErr?.status === 401) forceRefresh = true;
      if (!retryable || emittedText || attempt === maxRetries - 1) break;

      if (announced.size > 0) onRetry?.();
      await sleep(BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200), signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new CodexError('unknown Codex backend failure', { retryable: false });
}

/**
 * One-shot completion on the Codex backend. The backend only streams, so this
 * collects the stream. `maxTokens` / `temperature` are unsupported there and
 * intentionally ignored (the title prompts already bound their own output).
 */
export async function codexNonStreaming(
  messages: ChatMessage[],
  options: NonStreamingOptions = {},
): Promise<string> {
  const result = await codexStreamChat({
    messages,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    signal: options.signal,
    maxRetries: options.maxRetries,
  });
  return result.content;
}
