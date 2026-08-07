// OpenRouter chat.completions client.
//
// Two entry points:
//   streamChat(...)  — SSE streaming call with OpenAI-format tool calling.
//                      Text deltas are handed to a callback; tool_calls fragments
//                      are assembled across chunks by `index`.
//   nonStreaming(...) — one-shot completion, used for cheap auxiliary calls
//                      (initial and exit-time chat titling).
//
// Both retry up to 3 times with exponential backoff on 429 / 5xx / network
// errors. streamChat deliberately stops retrying once it has emitted its first
// text delta: a retry at that point would duplicate visible output.

/** Override to point at a proxy or a local mock (no trailing slash). */
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
const ENDPOINT = `${BASE_URL}/chat/completions`;

/** The model this product is built around (CONTRACT.md § Environment). */
export const MODEL = 'openai/gpt-5.6-sol';

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 600;
/** A stream with no bytes at all for this long is considered dead. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Wire types (OpenAI chat.completions shape)
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  /** assistant turns that requested tools */
  tool_calls?: ToolCall[];
  /** tool result turns */
  tool_call_id?: string;
  name?: string;
}

export interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export type ToolChoice = 'auto' | 'none' | 'required';

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /**
   * True when the stream ended without a finish signal after emitting text:
   * the content is real but possibly cut off. Never retried (the text is
   * already visible) — the caller decides how to surface the partial answer.
   */
  truncated?: boolean;
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  tools?: OpenRouterTool[];
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
  /** Called for every text delta as it arrives. */
  onText?: (delta: string) => void;
  /**
   * Called for every reasoning-trace delta (models that stream one). Reasoning
   * is not visible output, but it is evidence of life before the first tool
   * call or visible token and never counts as emitted text for retry purposes.
   */
  onReasoning?: (delta: string) => void;
  /** Called once the provider has accepted the request and the body is open. */
  onStreamOpen?: () => void;
  /**
   * Called the moment a tool call first appears in the stream — long before its
   * arguments have finished arriving. Lets the caller surface activity early.
   * Fired at most once per tool call, and only when the provider sent an id.
   */
  onToolCallStart?: (call: { id: string; name: string }) => void;
  /**
   * Called when a failed attempt is about to be retried, so the caller can roll
   * back anything it surfaced via onToolCallStart for the abandoned attempt.
   */
  onRetry?: () => void;
  model?: string;
  providerId?: string;
  /** Provider reasoning effort, sent as OpenRouter's `reasoning: { effort }`. */
  reasoningEffort?: string;
  temperature?: number;
  maxRetries?: number;
  /** Internal transport selected by llm.ts; never accepted from HTTP clients. */
  transport?: CompatibleTransport;
}

export interface NonStreamingOptions {
  model?: string;
  providerId?: string;
  /** Provider reasoning effort, sent as OpenRouter's `reasoning: { effort }`. */
  reasoningEffort?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  maxRetries?: number;
  transport?: CompatibleTransport;
}

export interface CompatibleTransport {
  endpoint: string;
  headers: Record<string, string>;
  name: string;
  /** Optional provider-specific additions or rewrites. */
  prepareBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OpenRouterError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable: boolean }) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = opts.status;
    this.retryable = opts.retryable;
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMExceptionLike());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMExceptionLike());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Minimal stand-in for an abort error so callers can treat it uniformly. */
class DOMExceptionLike extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new OpenRouterError('OPENROUTER_API_KEY is not set', { retryable: false });
  }
  return key;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:5174',
    'X-Title': 'Rautml',
  };
}

async function postChat(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  transport?: CompatibleTransport,
): Promise<Response> {
  const target = transport?.endpoint ?? ENDPOINT;
  const label = transport?.name ?? 'OpenRouter';
  let res: Response;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: transport?.headers ?? headers(),
      body: JSON.stringify(transport?.prepareBody?.(body) ?? body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Network-level failure — always worth a retry.
    throw new OpenRouterError(`network error: ${(err as Error).message}`, { retryable: true });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OpenRouterError(
      `${label} ${res.status}: ${text.slice(0, 500) || res.statusText}`,
      { status: res.status, retryable: isRetryableStatus(res.status) },
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Reasoning text out of a delta, across the shapes providers use behind
 * OpenRouter's normalisation: `reasoning` (most), `reasoning_content`
 * (DeepSeek), and `reasoning_details[]` (when details are passed through).
 */
function reasoningOf(delta: any): string {
  if (typeof delta?.reasoning === 'string') return delta.reasoning;
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content;
  const details = delta?.reasoning_details;
  if (Array.isArray(details)) {
    let out = '';
    for (const d of details) {
      if (typeof d?.text === 'string') out += d.text;
      else if (typeof d?.summary === 'string') out += d.summary;
    }
    return out;
  }
  return '';
}

/**
 * Reads an SSE body, feeding each `data:` JSON payload to `onChunk`.
 * Stops on `[DONE]` or stream end.
 */
async function readSse(res: Response, onChunk: (chunk: any) => void): Promise<void> {
  const body = res.body;
  if (!body) throw new OpenRouterError('empty response body', { retryable: true });

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleBlock = (block: string) => {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return true;
      try {
        onChunk(JSON.parse(payload));
      } catch {
        // Ignore malformed keep-alive / partial frames.
      }
    }
    return false;
  };

  try {
    for (;;) {
      // Any bytes (including keep-alive comments) reset the stall clock; a
      // connection that goes fully silent must not hang the run forever.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () =>
            reject(
              new OpenRouterError(`stream stalled for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`, {
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
      // SSE frames are separated by a blank line.
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (handleBlock(block)) return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
  } catch (err) {
    // Drop the half-read body so the connection isn't left dangling.
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock?.();
  }
}

// ---------------------------------------------------------------------------
// streamChat
// ---------------------------------------------------------------------------

export async function streamChat(options: StreamChatOptions): Promise<StreamResult> {
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
    model = MODEL,
    reasoningEffort,
    temperature,
    maxRetries = DEFAULT_MAX_RETRIES,
    transport,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMExceptionLike();

    let emittedText = false;
    let content = '';
    const toolAcc = new Map<number, ToolCallAccumulator>();
    const announced = new Set<number>();
    let finishReason: string | null = null;

    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice;
      }
      if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
      if (typeof temperature === 'number') body.temperature = temperature;

      const res = await postChat(body, signal, transport);
      onStreamOpen?.();

      await readSse(res, (chunk) => {
        const choice = chunk?.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};

        const thought = reasoningOf(delta);
        if (thought) onReasoning?.(thought);

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          emittedText = true;
          onText?.(delta.content);
        }

        const fragments = delta.tool_calls;
        if (Array.isArray(fragments)) {
          for (const frag of fragments) {
            const index: number = typeof frag.index === 'number' ? frag.index : toolAcc.size;
            let acc = toolAcc.get(index);
            if (!acc) {
              acc = { id: '', name: '', arguments: '' };
              toolAcc.set(index, acc);
            }
            if (frag.id) acc.id = frag.id;
            if (frag.function?.name) acc.name += frag.function.name;
            if (typeof frag.function?.arguments === 'string') {
              acc.arguments += frag.function.arguments;
            }
            // Announce the call as soon as we know who it is — its arguments
            // may take many seconds more to stream (e.g. a whole HTML file).
            if (!announced.has(index) && acc.id && acc.name) {
              announced.add(index);
              onToolCallStart?.({ id: acc.id, name: acc.name });
            }
          }
        }
      });

      const toolCalls: ToolCall[] = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, acc]) => ({
          id: acc.id || `call_${index}_${Date.now().toString(36)}`,
          type: 'function' as const,
          function: { name: acc.name, arguments: acc.arguments || '{}' },
        }))
        .filter((tc) => tc.function.name.length > 0);

      // No finish_reason means the connection dropped mid-response: the reader
      // sees a clean end-of-stream, but the model never finished its turn.
      // Treating that as a final answer is what makes runs silently die off.
      if (!finishReason) {
        const argsTruncated = toolCalls.some((tc) => {
          try {
            JSON.parse(tc.function.arguments);
            return false;
          } catch {
            return true;
          }
        });
        if (argsTruncated || (toolCalls.length === 0 && content.length === 0)) {
          throw new OpenRouterError('stream ended unexpectedly (no finish_reason)', {
            retryable: true,
          });
        }
      }
      // Text without a finish_reason is kept (retrying would duplicate visible
      // output) but flagged so the caller can tell the answer may be cut off.
      const truncated = !finishReason && content.length > 0;
      if (!finishReason && toolCalls.length > 0) finishReason = 'tool_calls';

      return { content, toolCalls, finishReason, ...(truncated ? { truncated } : {}) };
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;

      const retryable = err instanceof OpenRouterError ? err.retryable : true;
      // Never retry once visible text has been produced — it would duplicate.
      // Announced tool calls are fine: onRetry lets the caller roll them back.
      if (!retryable || emittedText || attempt === maxRetries - 1) break;

      if (announced.size > 0) onRetry?.();
      await sleep(BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200), signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new OpenRouterError('unknown OpenRouter failure', { retryable: false });
}

// ---------------------------------------------------------------------------
// nonStreaming — cheap one-shot completions (chat titling)
// ---------------------------------------------------------------------------

export async function nonStreaming(
  messages: ChatMessage[],
  options: NonStreamingOptions = {},
): Promise<string> {
  const {
    model = MODEL,
    reasoningEffort,
    temperature,
    maxTokens,
    signal,
    maxRetries = DEFAULT_MAX_RETRIES,
    transport,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMExceptionLike();
    try {
      const body: Record<string, unknown> = { model, messages, stream: false };
      if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
      if (typeof temperature === 'number') body.temperature = temperature;
      if (typeof maxTokens === 'number') body.max_tokens = maxTokens;

      const res = await postChat(body, signal, transport);
      const json: any = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : '';
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      const retryable = err instanceof OpenRouterError ? err.retryable : true;
      if (!retryable || attempt === maxRetries - 1) break;
      await sleep(BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200), signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new OpenRouterError('unknown OpenRouter failure', { retryable: false });
}
