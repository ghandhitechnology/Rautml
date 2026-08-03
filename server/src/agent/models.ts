// The model catalog: every model the composer can select, with the reasoning
// effort levels each provider actually exposes (verified against provider docs
// via OpenRouter's unified `reasoning.effort` parameter, 2026-08).
//
//   OpenAI GPT-5.6 (sol/terra/luna): none | low | medium | high | xhigh | max, default medium
//   xAI Grok 4.5:                    low | medium | high, default high (cannot be disabled)
//   DeepSeek V4 Flash 0731:          low | high | max, default high
//
// The wire values are sent verbatim as `reasoning: { effort }` — OpenRouter
// passes them through to each provider.

import type { ModelInfo } from '../types.js';

const GPT56_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

export const MODELS: ModelInfo[] = [
  {
    id: 'openai/gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    shortName: 'Sol',
    provider: 'OpenAI',
    description: 'Highest reasoning ceiling — deep research and long agentic runs',
    efforts: GPT56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    shortName: 'Terra',
    provider: 'OpenAI',
    description: 'The balanced default — strong everyday reasoning',
    efforts: GPT56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    shortName: 'Luna',
    provider: 'OpenAI',
    description: 'Light and fast — smaller tasks at the lowest cost',
    efforts: GPT56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'x-ai/grok-4.5',
    name: 'Grok 4.5',
    shortName: 'Grok 4.5',
    provider: 'xAI',
    description: 'Frontier coding and reasoning; thinking always on',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    shortName: 'V4 Flash',
    provider: 'DeepSeek',
    description: 'Open-weight MoE tuned for coding, chat and agents',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
];

/** CONTRACT.md § Environment — the model the product defaults to. */
export const DEFAULT_MODEL_ID = 'openai/gpt-5.6-sol';

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Validates a client-supplied selection. Returns the resolved pair, or a
 * string describing what was wrong (routes turn that into a 400).
 */
export function resolveSelection(
  model?: string,
  effort?: string,
): { model: string; effort: string } | string {
  const def = getModel(model || DEFAULT_MODEL_ID);
  if (!def) return `Unknown model: ${model}`;
  if (effort !== undefined && !def.efforts.includes(effort)) {
    return `${def.name} supports reasoning effort ${def.efforts.join(' | ')}, got: ${effort}`;
  }
  return { model: def.id, effort: effort ?? def.defaultEffort };
}
