// visualize_read_me, visualize_show_widget, ask_user_input_v0 (CONTRACT.md tools 9-11).
import type { ToolCtx, ToolDef } from '../types.js';
import { createPendingInput } from '../repo.js';
import { DESIGN_README } from '../agent/prompts.js';

const visualizeReadMe: ToolDef = {
  name: 'visualize_read_me',
  description:
    'Read the design constraints for building HTML assets. MUST be called before creating the first asset in a chat.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args: any, _ctx: ToolCtx): Promise<string> {
    return DESIGN_README;
  },
};

const visualizeShowWidget: ToolDef = {
  name: 'visualize_show_widget',
  description:
    'Render a small inline HTML/SVG widget directly in the chat flow (not a full asset) — for quick mini-visuals.',
  parameters: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'Self-contained HTML/SVG markup for the widget.' },
    },
    required: ['html'],
    additionalProperties: false,
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    const html = String(args?.html ?? '');
    ctx.emit('widget', { messageId: ctx.messageId, html });
    return 'Widget rendered.';
  },
};

const askUserInputV0: ToolDef = {
  name: 'ask_user_input_v0',
  description:
    'Ask the user a clarifying question with selectable options and pause the run until they respond. ' +
    'NOTE: the engine intercepts this tool specially to park the run — it never calls execute in normal operation.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Selectable option strings the user can tap.',
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  // Defensive fallback: engine should intercept ask_user_input_v0 before execute is ever
  // invoked (parking the run instead). If it ever is invoked directly, still do the right
  // thing: create the pending_input row + emit input.request, and return a marker string.
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    const question = String(args?.question ?? '');
    const options = Array.isArray(args?.options) ? args.options.map((o: any) => String(o)) : [];
    const pending = createPendingInput({
      runId: ctx.runId,
      chatId: ctx.chatId,
      thread: ctx.thread,
      question,
      options,
    });
    ctx.emit('input.request', { pendingInputId: pending.id, question, options });
    return 'AWAITING_USER_INPUT';
  },
};

export const uxTools: ToolDef[] = [visualizeReadMe, visualizeShowWidget, askUserInputV0];
