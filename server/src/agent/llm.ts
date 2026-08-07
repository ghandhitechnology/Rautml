// Provider dispatch for Rautml's own agent engine. CLIs only discover catalogs
// and manage local sign-in; model turns always use these in-process adapters.
// resolveTitleSelection / resolveSubagentProvider pick workable routes for the
// auxiliary calls (titling, research subagents) so they keep functioning on
// OpenRouter-only installs.

import * as openrouter from './openrouter.js';
import { codexAvailable, codexNonStreaming, codexStreamChat } from './codex.js';
import { compatibleTransport, ProviderUnavailableError, providerConnected } from './providers.js';
import type { ChatMessage, NonStreamingOptions, StreamChatOptions, StreamResult } from './openrouter.js';

export type {
  ChatMessage,
  ChatRole,
  NonStreamingOptions,
  OpenRouterTool,
  StreamChatOptions,
  StreamResult,
  ToolCall,
  ToolChoice,
} from './openrouter.js';

export { ProviderUnavailableError } from './providers.js';

function inferredProvider(model?: string): string {
  const id = model ?? openrouter.MODEL;
  if (id.startsWith('openai/')) return 'codex';
  if (id.startsWith('x-ai/')) return 'grok-build';
  if (id.startsWith('opencode-go/')) return 'opencode-go';
  if (id.startsWith('opencode/')) return 'opencode-zen';
  if (id.startsWith('kimi-code/')) return 'kimi-code';
  return 'openrouter';
}

function providerFor(options: { providerId?: string; model?: string }): string {
  return options.providerId || inferredProvider(options.model);
}

/** The light model auxiliary calls (chat titling) run on. */
const TITLE_MODEL = 'openai/gpt-5.6-luna';

/**
 * Where chat titling can run: the Codex route when that provider is connected,
 * the same model explicitly through OpenRouter when only OpenRouter is
 * connected, else null — the caller skips titling instead of failing.
 */
export function resolveTitleSelection(): { model: string; providerId?: string } | null {
  if (providerConnected('codex')) return { model: TITLE_MODEL };
  if (providerConnected('openrouter')) return { model: TITLE_MODEL, providerId: 'openrouter' };
  return null;
}

/**
 * Subagent streams infer their provider from the model id, which points at a
 * CLI that may not be connected. Route them through OpenRouter whenever it is
 * connected so subagents work on OpenRouter-only installs; otherwise keep the
 * CLI-inferred provider (undefined).
 */
export function resolveSubagentProvider(model: string): string | undefined {
  return providerConnected('openrouter') ? 'openrouter' : undefined;
}

export async function streamChat(options: StreamChatOptions): Promise<StreamResult> {
  const providerId = providerFor(options);
  if (providerId === 'codex') {
    if (!codexAvailable()) {
      return Promise.reject(new ProviderUnavailableError('codex', 'Codex is not connected. Run `codex login`.'));
    }
    return codexStreamChat({ ...options, model: options.model ?? openrouter.MODEL });
  }
  return openrouter.streamChat({
    ...options,
    model: options.model ?? openrouter.MODEL,
    transport: await compatibleTransport(providerId, options.model ?? openrouter.MODEL),
  });
}

export async function nonStreaming(messages: ChatMessage[], options: NonStreamingOptions = {}): Promise<string> {
  const providerId = providerFor(options);
  if (providerId === 'codex') {
    if (!codexAvailable()) {
      return Promise.reject(new ProviderUnavailableError('codex', 'Codex is not connected. Run `codex login`.'));
    }
    return codexNonStreaming(messages, { ...options, model: options.model ?? openrouter.MODEL });
  }
  return openrouter.nonStreaming(messages, {
    ...options,
    model: options.model ?? openrouter.MODEL,
    transport: await compatibleTransport(providerId, options.model ?? openrouter.MODEL),
  });
}
