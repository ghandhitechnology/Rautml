// Provider dispatch: one streamChat/nonStreaming for the whole app.
//
// OpenAI models (openai/gpt-5.6-*) run on the user's ChatGPT subscription via
// the Codex CLI's OAuth credentials when those exist (~/.codex/auth.json);
// everything else — and every model when Codex auth is absent or
// RAUTML_CODEX=0 — goes through OpenRouter. Callers keep the exact
// openrouter.ts contract and cannot tell the providers apart.

import * as openrouter from './openrouter.js';
import { codexAvailable, codexNonStreaming, codexStreamChat } from './codex.js';
import type {
  ChatMessage,
  NonStreamingOptions,
  StreamChatOptions,
  StreamResult,
} from './openrouter.js';

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

const CODEX_DISABLED = process.env.RAUTML_CODEX === '0';

function viaCodex(model?: string): boolean {
  return (
    !CODEX_DISABLED && (model ?? openrouter.MODEL).startsWith('openai/') && codexAvailable()
  );
}

// One boot-time line so it's obvious which wallet the OpenAI models bill to.
if (!CODEX_DISABLED && codexAvailable()) {
  console.log('[llm] openai/* models → ChatGPT Codex OAuth (~/.codex/auth.json); others → OpenRouter');
} else {
  console.log('[llm] all models → OpenRouter' + (CODEX_DISABLED ? ' (RAUTML_CODEX=0)' : ''));
}

export function streamChat(options: StreamChatOptions): Promise<StreamResult> {
  return viaCodex(options.model)
    ? codexStreamChat({ ...options, model: options.model ?? openrouter.MODEL })
    : openrouter.streamChat(options);
}

export function nonStreaming(
  messages: ChatMessage[],
  options: NonStreamingOptions = {},
): Promise<string> {
  return viaCodex(options.model)
    ? codexNonStreaming(messages, { ...options, model: options.model ?? openrouter.MODEL })
    : openrouter.nonStreaming(messages, options);
}
