// Provider dispatch for Rautml's own agent engine. CLIs only discover catalogs
// and manage local sign-in; model turns always use these in-process adapters.

import * as openrouter from './openrouter.js';
import { codexAvailable, codexNonStreaming, codexStreamChat } from './codex.js';
import { compatibleTransport, ProviderUnavailableError } from './providers.js';
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
