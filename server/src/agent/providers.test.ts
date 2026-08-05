import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { streamChat } from './openrouter.js';
import { DEFAULT_MODEL_ID, discoverProviders, resolveProviderSelection } from './providers.js';
import * as repo from '../repo.js';

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

  it('resolves the explicit default without rewriting its provider', async () => {
    const selected = await resolveProviderSelection(DEFAULT_MODEL_ID);
    assert.ok(selected);
    assert.equal(selected.id, DEFAULT_MODEL_ID);
    assert.equal(selected.providerId, 'codex');
    assert.equal(selected.modelId, 'openai/gpt-5.6-sol');
  });

  it('does not invent a fallback for an unknown selection', async () => {
    assert.equal(await resolveProviderSelection('not-a-provider:model'), null);
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

  before(async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
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
    assert.equal(streamed, 'ok');
    assert.equal(received.model, 'catalog-model');
    assert.deepEqual(received.reasoning, { effort: 'high' });
  });
});
