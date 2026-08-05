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

import type { ElaborationLevel, ModelInfo } from '../types.js';
import { resolveProviderSelection } from './providers.js';

const GPT56_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

export const MODELS: ModelInfo[] = [
  {
    id: 'openai/gpt-5.6-sol',
    modelId: 'openai/gpt-5.6-sol',
    providerId: 'codex',
    name: 'GPT-5.6 Sol',
    shortName: 'Sol',
    provider: 'OpenAI',
    description: 'Highest reasoning ceiling — deep research and long agentic runs',
    efforts: GPT56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-terra',
    modelId: 'openai/gpt-5.6-terra',
    providerId: 'codex',
    name: 'GPT-5.6 Terra',
    shortName: 'Terra',
    provider: 'OpenAI',
    description: 'The balanced default — strong everyday reasoning',
    efforts: GPT56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-luna',
    modelId: 'openai/gpt-5.6-luna',
    providerId: 'codex',
    name: 'GPT-5.6 Luna',
    shortName: 'Luna',
    provider: 'OpenAI',
    description: 'Light and fast — smaller tasks at the lowest cost',
    efforts: GPT56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'x-ai/grok-4.5',
    modelId: 'x-ai/grok-4.5',
    providerId: 'grok-build',
    name: 'Grok 4.5',
    shortName: 'Grok 4.5',
    provider: 'xAI',
    description: 'Frontier coding and reasoning; thinking always on',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    modelId: 'deepseek/deepseek-v4-flash-0731',
    providerId: 'openrouter',
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

/** Elaboration levels the composer's audience pebble offers, least → most expert. */
export const ELABORATIONS: ElaborationLevel[] = ['undergraduate', 'bachelors', 'doctor'];

export const DEFAULT_ELABORATION: ElaborationLevel = 'bachelors';

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Validates a client-supplied selection. Returns the resolved pair, or a
 * string describing what was wrong (routes turn that into a 400).
 */
export async function resolveSelection(
  model?: string,
  effort?: string,
  elaboration?: string,
): Promise<{ providerId: string; model: string; selectionId: string; effort: string; elaboration: ElaborationLevel } | string> {
  const def = await resolveProviderSelection(model);
  if (!def) return `Unknown model: ${model}`;
  if (effort !== undefined && !def.efforts.includes(effort)) {
    return `${def.name} supports reasoning effort ${def.efforts.join(' | ')}, got: ${effort}`;
  }
  if (elaboration !== undefined && !ELABORATIONS.includes(elaboration as ElaborationLevel)) {
    return `elaboration must be ${ELABORATIONS.join(' | ')}, got: ${elaboration}`;
  }
  return {
    providerId: def.providerId,
    model: def.modelId,
    selectionId: def.id,
    effort: effort ?? def.defaultEffort,
    elaboration: (elaboration as ElaborationLevel) ?? DEFAULT_ELABORATION,
  };
}
