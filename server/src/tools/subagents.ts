// `spawn_subagents` — the lead agent fans a big research job out to 2–5
// parallel subagents. Each subagent is a mini agentic loop with its own
// OpenRouter stream and its own tool calling over the research tools only;
// its lifecycle and activity surface as `subagent.*` SSE events (persisted
// like every other event, so a reload replays them). The combined reports are
// the tool result the lead agent synthesizes from.

import { randomUUID } from 'node:crypto';
import { getModel } from '../agent/models.js';
import { streamChat, type ChatMessage, type OpenRouterTool } from '../agent/openrouter.js';
import { SUBAGENT_SYSTEM_PROMPT } from '../agent/prompts.js';
import type { ToolCtx, ToolDef } from '../types.js';
import { researchTools } from './research.js';

/** The models a research subagent may run on; the first is the default. */
export const SUBAGENT_MODELS = ['x-ai/grok-4.5', 'openai/gpt-5.6-luna'] as const;
const DEFAULT_SUBAGENT_MODEL = SUBAGENT_MODELS[0];

/**
 * Reasoning effort per subagent model; models not listed run at their catalog
 * default. Luna is the light model — xhigh buys back depth on its briefs.
 */
const SUBAGENT_EFFORTS: Record<string, string> = {
  'openai/gpt-5.6-luna': 'xhigh',
};

const MAX_TASKS = 5;
/** Tool calls one subagent may make before it is nudged to report. */
const SUBAGENT_MAX_TOOL_CALLS = 12;
const SUBAGENT_MAX_ITERATIONS = SUBAGENT_MAX_TOOL_CALLS + 4;
/** Tool results inside a subagent's own context are kept slim. */
const SUBAGENT_TOOL_RESULT_MAX = 12_000;
/** Combined budget for all reports (the engine truncates tool results at 24k). */
const REPORTS_TOTAL_BUDGET = 22_000;

const SUBAGENT_WRAP_UP =
  'You have reached your tool-call budget. Stop searching and write your final report now from what you already have. Note briefly what is missing, if anything.';

interface SubagentTask {
  title: string;
  prompt: string;
  model: string;
}

interface SubagentOutcome {
  title: string;
  model: string;
  ok: boolean;
  report: string;
  toolCalls: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n\n[…truncated…]\n\n';
  const half = Math.floor((max - marker.length) / 2);
  return text.slice(0, half) + marker + text.slice(text.length - half);
}

function hostOf(url: unknown): string {
  const raw = typeof url === 'string' ? url : '';
  try {
    return new URL(raw).host;
  } catch {
    return clip(raw, 60);
  }
}

/** Research-tool labels, mirroring the engine's wording for the same tools. */
function subToolLabel(name: string, args: any): string {
  switch (name) {
    case 'web_search':
      return `Searching: “${clip(String(args?.query ?? ''), 70)}”`;
    case 'image_search':
      return `Finding images: “${clip(String(args?.query ?? ''), 70)}”`;
    case 'web_fetch':
      return `Reading: ${hostOf(args?.url)}`;
    default:
      return name.replace(/_/g, ' ');
  }
}

function subToolSummary(name: string, result: string, ok: boolean): string {
  if (!ok) return clip(result, 160) || 'Failed';
  if (name === 'web_search' || name === 'image_search') {
    const lines = result.split('\n').filter((l) => /^\d+\. /.test(l)).length;
    if (lines > 0) return `${lines} result${lines === 1 ? '' : 's'}`;
  }
  if (name === 'web_fetch') return `${result.length.toLocaleString('en-US')} chars`;
  return clip(result.split('\n').find((l) => l.trim().length > 0) ?? '', 140) || 'Done';
}

function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { name?: string }).name === 'AbortError' ||
      (err as { code?: string }).code === 'ABORT_ERR')
  );
}

function parseTasks(args: any): SubagentTask[] | string {
  const raw = args?.tasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'tasks must be a non-empty array of { title, prompt, model? }';
  }
  const tasks: SubagentTask[] = [];
  for (const entry of raw.slice(0, MAX_TASKS)) {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
    const prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim() : '';
    if (!title || !prompt) return 'every task needs a non-empty title and prompt';
    const requested = typeof entry?.model === 'string' ? entry.model : '';
    const model = getModel(requested) ? requested : DEFAULT_SUBAGENT_MODEL;
    tasks.push({ title, prompt, model });
  }
  return tasks;
}

/** One subagent: its own stream, its own tool loop, one report at the end. */
async function runSubagent(
  task: SubagentTask,
  ctx: ToolCtx,
  reportBudget: number,
): Promise<SubagentOutcome> {
  const subagentId = randomUUID();
  const wireTools: OpenRouterTool[] = researchTools.map((def) => ({
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.parameters },
  }));
  const toolsByName = new Map(researchTools.map((def) => [def.name, def]));
  const effort = SUBAGENT_EFFORTS[task.model] ?? getModel(task.model)?.defaultEffort;

  ctx.emit('subagent.start', {
    subagentId,
    parentToolCallId: ctx.toolCallId ?? '',
    title: task.title,
    model: task.model,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: `# Research brief: ${task.title}\n\n${task.prompt}` },
  ];

  let toolCalls = 0;
  let nudged = false;
  let allText = '';
  let lastText = '';

  try {
    for (let iteration = 0; iteration < SUBAGENT_MAX_ITERATIONS; iteration++) {
      if (ctx.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

      if (!nudged && (toolCalls >= SUBAGENT_MAX_TOOL_CALLS || iteration === SUBAGENT_MAX_ITERATIONS - 1)) {
        messages.push({ role: 'user', content: SUBAGENT_WRAP_UP });
        nudged = true;
      }

      let iterationText = '';
      const result = await streamChat({
        messages,
        tools: wireTools,
        toolChoice: nudged ? 'none' : 'auto',
        model: task.model,
        reasoningEffort: effort,
        signal: ctx.signal,
        onText: (delta) => {
          iterationText += delta;
          ctx.emit('subagent.delta', { subagentId, text: delta });
        },
      });

      const content = result.content ?? '';
      if (content.trim().length > 0) {
        allText += (allText ? '\n\n' : '') + content;
        lastText = content;
      }

      const assistantTurn: ChatMessage = { role: 'assistant', content };
      if (result.toolCalls.length > 0) assistantTurn.tool_calls = result.toolCalls;
      messages.push(assistantTurn);

      if (result.toolCalls.length === 0) break;

      for (const call of result.toolCalls) {
        if (ctx.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        const name = call.function.name;
        let args: any = {};
        let ok = true;
        let output = '';
        try {
          const trimmed = (call.function.arguments ?? '').trim();
          args = trimmed ? JSON.parse(trimmed) : {};
        } catch (err) {
          ok = false;
          output = `Invalid JSON arguments: ${(err as Error).message}`;
        }

        ctx.emit('subagent.tool.start', {
          subagentId,
          toolCallId: call.id,
          name,
          label: subToolLabel(name, args),
        });

        if (ok) {
          const def = toolsByName.get(name);
          if (!def) {
            ok = false;
            output = `Unknown tool: ${name}`;
          } else {
            try {
              output = (await def.execute(args, ctx)) ?? '';
            } catch (err) {
              if (isAbort(err)) throw err;
              ok = false;
              output = `Error: ${(err as Error)?.message ?? String(err)}`;
            }
          }
        }

        const stored = truncateMiddle(output, SUBAGENT_TOOL_RESULT_MAX);
        ctx.emit('subagent.tool.end', {
          subagentId,
          toolCallId: call.id,
          name,
          ok,
          summary: subToolSummary(name, stored, ok),
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: stored });
        toolCalls += 1;
      }
    }

    const report = truncateMiddle((lastText || allText).trim(), reportBudget);
    const ok = report.length > 0;
    ctx.emit('subagent.end', {
      subagentId,
      ok,
      summary: ok
        ? `${toolCalls} step${toolCalls === 1 ? '' : 's'} · ${report.length.toLocaleString('en-US')} chars`
        : 'Returned no report',
    });
    return { title: task.title, model: task.model, ok, report, toolCalls };
  } catch (err) {
    if (isAbort(err)) throw err;
    const detail = clip((err as Error)?.message ?? String(err), 200);
    ctx.emit('subagent.end', { subagentId, ok: false, summary: detail || 'Failed' });
    return {
      title: task.title,
      model: task.model,
      ok: false,
      report: `(subagent failed: ${detail})`,
      toolCalls,
    };
  }
}

const spawn_subagents: ToolDef = {
  name: 'spawn_subagents',
  description:
    'Divide a large research job across 2–5 parallel research subagents. Each task becomes an independent subagent with its own web_search / web_fetch / image_search loop that researches the brief and reports back; the combined reports are returned to you. Briefs must be self-contained — a subagent sees nothing of this conversation. Use once, early, when research is bigger than a medium-large task; do not use for small look-ups. Subagents cannot spawn subagents, write files, or ask the user anything.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 2,
        maxItems: MAX_TASKS,
        description: 'One focused research brief per subagent.',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Short human-readable name for the brief (shown in the activity timeline).',
            },
            prompt: {
              type: 'string',
              description:
                'The full self-contained brief: what to research, what specifics to find, and what the report must contain.',
            },
            model: {
              type: 'string',
              enum: [...SUBAGENT_MODELS],
              description:
                'Model for this subagent. Default x-ai/grok-4.5 (thorough); openai/gpt-5.6-luna for lighter look-ups.',
            },
          },
          required: ['title', 'prompt'],
        },
      },
    },
    required: ['tasks'],
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    const tasks = parseTasks(args);
    if (typeof tasks === 'string') return `ERROR: ${tasks}`;

    const reportBudget = Math.max(4_000, Math.floor(REPORTS_TOTAL_BUDGET / tasks.length));
    const outcomes = await Promise.all(tasks.map((task) => runSubagent(task, ctx, reportBudget)));

    const okCount = outcomes.filter((o) => o.ok).length;
    const sections = outcomes.map(
      (o, i) =>
        `## [${i + 1}] ${o.title} — ${o.ok ? 'ok' : 'FAILED'} (${o.model}, ${o.toolCalls} tool call${o.toolCalls === 1 ? '' : 's'})\n\n${o.report}`,
    );
    return [
      `${okCount}/${outcomes.length} subagents reported.`,
      ...sections,
      'Synthesize from these reports. Verify anything surprising yourself before asserting it, and fill any gaps the failed or thin reports left.',
    ].join('\n\n');
  },
};

export const subagentTools: ToolDef[] = [spawn_subagents];
