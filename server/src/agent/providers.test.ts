import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { streamChat } from './openrouter.js';
import {
  DEFAULT_MODEL_ID,
  defaultModelId,
  discoverProviders,
  invalidateProviderCache,
  providerConnected,
  reconnectCommand,
  resolveProviderSelection,
} from './providers.js';
import { resolveSubagentProvider, resolveTitleSelection } from './llm.js';
import * as repo from '../repo.js';

/** Runs `fn` with the given env vars overridden, restoring them afterwards. */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('local provider discovery', () => {
  it('keeps Go and Zen as separate catalogs with globally unique selections', async () => {
    const providers = await discoverProviders(true);
    assert.deepEqual(
      providers.map((provider) => provider.id),
      ['codex', 'grok-build', 'opencode-go', 'opencode-zen', 'kimi-code', 'openrouter'],
    );
    const ids = providers.flatMap((provider) => provider.models.map((model) => model.id));
    assert.equal(new Set(ids).size, ids.length);
    for (const provider of providers) {
      for (const model of provider.models) {
        assert.equal(model.providerId, provider.id);
        assert.ok(model.id.startsWith(`${provider.id}:`));
      }
    }
  });

  it('resolves an explicit selection without rewriting its provider', async () => {
    const selected = await resolveProviderSelection('openrouter:openai/gpt-5.6-sol');
    assert.ok(selected);
    assert.equal(selected.id, 'openrouter:openai/gpt-5.6-sol');
    assert.equal(selected.providerId, 'openrouter');
    assert.equal(selected.modelId, 'openai/gpt-5.6-sol');
  });

  it('does not invent a fallback for an unknown selection', async () => {
    assert.equal(await resolveProviderSelection('not-a-provider:model'), null);
  });

  it('targets each OpenCode catalog during reconnect', () => {
    assert.equal(reconnectCommand('opencode-go'), 'opencode auth login --provider opencode-go');
    assert.equal(reconnectCommand('opencode-zen'), 'opencode auth login --provider opencode');
  });
});

describe('default model selection', () => {
  it('returns the catalog default when its provider is connected', async () => {
    const providers = await discoverProviders(true);
    const home = providers.find((p) => p.models.some((m) => m.id === DEFAULT_MODEL_ID));
    if (home?.authStatus !== 'connected') return; // no connected Codex on this machine
    assert.equal(await defaultModelId(), DEFAULT_MODEL_ID);
  });

  it('skips a disconnected catalog default for the first connected provider', async () => {
    await withEnv({ RAUTML_CODEX: '0' }, async () => {
      const providers = await discoverProviders(true);
      assert.notEqual(providers.find((p) => p.id === 'codex')?.authStatus, 'connected');
      const firstConnected = providers.find((p) => p.authStatus === 'connected' && p.models.length);
      const id = await defaultModelId();
      if (firstConnected) {
        assert.equal(id, firstConnected.models[0]!.id);
        assert.notEqual(id, DEFAULT_MODEL_ID);
      } else {
        // Nobody connected: the legacy fallback chain still applies.
        assert.equal(id, providers.find((p) => p.models.length)?.models[0]?.id ?? DEFAULT_MODEL_ID);
      }
    });
    invalidateProviderCache();
  });
});

describe('title and subagent routing', () => {
  it('prefers the Codex route for titling when Codex is connected', () => {
    if (!providerConnected('codex')) return; // no Codex auth on this machine
    assert.deepEqual(resolveTitleSelection(), { model: 'openai/gpt-5.6-luna' });
  });

  it('falls back to the OpenRouter route when Codex is vetoed', async () => {
    await withEnv({ RAUTML_CODEX: '0', OPENROUTER_API_KEY: 'sk-or-test' }, () => {
      assert.deepEqual(resolveTitleSelection(), { model: 'openai/gpt-5.6-luna', providerId: 'openrouter' });
    });
  });

  it('returns null when neither titling route is connected', async () => {
    await withEnv({ RAUTML_CODEX: '0', OPENROUTER_API_KEY: undefined }, () => {
      assert.equal(resolveTitleSelection(), null);
    });
  });

  it('routes subagents through OpenRouter exactly when it is connected', async () => {
    await withEnv({ OPENROUTER_API_KEY: 'sk-or-test' }, () => {
      assert.equal(resolveSubagentProvider('x-ai/grok-4.5'), 'openrouter');
    });
    await withEnv({ OPENROUTER_API_KEY: undefined }, () => {
      assert.equal(resolveSubagentProvider('x-ai/grok-4.5'), undefined);
    });
  });
});

describe('run persistence', () => {
  it('round-trips the exact provider and model independently', () => {
    const chat = repo.createChat();
    try {
      const run = repo.createRun(chat.id, 'main', 'opencode-go', 'opencode-go/kimi-k3', 'high');
      const stored = repo.getRun(run.id);
      assert.equal(stored?.providerId, 'opencode-go');
      assert.equal(stored?.model, 'opencode-go/kimi-k3');
      assert.equal(stored?.effort, 'high');
    } finally {
      repo.deleteChat(chat.id);
    }
  });
});

describe('OpenAI-compatible provider transport', () => {
  let endpoint = '';
  let close: (() => Promise<void>) | undefined;
  let received: any;

  const defaultReply = (res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  let reply = defaultReply;

  before(async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received = JSON.parse(body);
        reply(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    endpoint = `http://127.0.0.1:${address.port}/chat/completions`;
    close = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  after(async () => { await close?.(); });

  it('streams text and applies provider-specific model rewriting', async () => {
    let streamed = '';
    const result = await streamChat({
      model: 'namespace/catalog-model',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'high',
      onText: (value) => { streamed += value; },
      transport: {
        endpoint,
        name: 'Mock provider',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        prepareBody: (body) => ({ ...body, model: 'catalog-model' }),
      },
    });
    assert.equal(result.content, 'ok');
    assert.equal(result.truncated, undefined);
    assert.equal(streamed, 'ok');
    assert.equal(received.model, 'catalog-model');
    assert.deepEqual(received.reasoning, { effort: 'high' });
  });

  it('flags text that arrived without a finish_reason as truncated instead of failing', async () => {
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n');
    };
    try {
      const result = await streamChat({
        model: 'namespace/catalog-model',
        messages: [{ role: 'user', content: 'hello' }],
        transport: {
          endpoint,
          name: 'Mock provider',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        },
      });
      assert.equal(result.content, 'partial');
      assert.equal(result.finishReason, null);
      assert.equal(result.truncated, true);
    } finally {
      reply = defaultReply;
    }
  });

  it('still rejects a stream that ends with nothing at all', async () => {
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    };
    try {
      await assert.rejects(
        streamChat({
          model: 'namespace/catalog-model',
          messages: [{ role: 'user', content: 'hello' }],
          maxRetries: 1,
          transport: {
            endpoint,
            name: 'Mock provider',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
          },
        }),
        /no finish_reason/,
      );
    } finally {
      reply = defaultReply;
    }
  });
});
