import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ToolCtx } from '../types.js';
import { browserService } from './browser.js';
import { researchTools } from './research.js';

const originalFetch = globalThis.fetch;
const originalSearch = browserService.search;
const originalImageSearch = browserService.imageSearch;
const originalFetchPage = browserService.fetchPage;
const originalBrowserbaseKey = process.env.BROWSERBASE_API_KEY;
const originalBrowserbaseProject = process.env.BROWSERBASE_PROJECT_ID;
const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;

function context(): { ctx: ToolCtx; directory: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'rautml-research-'));
  return {
    directory,
    ctx: {
      chatId: 'chat',
      runId: 'run',
      thread: 'main',
      workspaceDir: directory,
      messageId: 'message',
      emit() {},
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  browserService.search = originalSearch;
  browserService.imageSearch = originalImageSearch;
  browserService.fetchPage = originalFetchPage;
  restoreEnv('BROWSERBASE_API_KEY', originalBrowserbaseKey);
  restoreEnv('BROWSERBASE_PROJECT_ID', originalBrowserbaseProject);
  restoreEnv('FIRECRAWL_API_KEY', originalFirecrawlKey);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Browserbase research fallback', () => {
  it('uses Browserbase search when Firecrawl is unavailable', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.BROWSERBASE_API_KEY = 'bb-key';
    process.env.BROWSERBASE_PROJECT_ID = 'bb-project';
    let query = '';
    browserService.search = async (value) => {
      query = value;
      return [{ title: 'Browser result', url: 'https://example.com', snippet: 'Rendered result' }];
    };
    const { ctx, directory } = context();
    try {
      const tool = researchTools.find((item) => item.name === 'web_search')!;
      const output = await tool.execute({ query: 'browserbase test' }, ctx);
      assert.equal(query, 'browserbase test');
      assert.match(output, /<untrusted_web_content>/);
      assert.match(output, /Browser result/);
      assert.match(output, /Rendered result/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the rendered Browserbase page before direct fetch', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.BROWSERBASE_API_KEY = 'bb-key';
    process.env.BROWSERBASE_PROJECT_ID = 'bb-project';
    browserService.fetchPage = async (url) => `Rendered: ${url}`;
    globalThis.fetch = async () => { throw new Error('direct fetch should not run'); };
    const { ctx, directory } = context();
    try {
      const tool = researchTools.find((item) => item.name === 'web_fetch')!;
      const output = await tool.execute({ url: 'https://example.com/app' }, ctx);
      assert.equal(output, '<untrusted_web_content>\nRendered: https://example.com/app\n</untrusted_web_content>');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks private destinations before the direct-fetch fallback', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response('unexpected');
    };
    const { ctx, directory } = context();
    try {
      const tool = researchTools.find((item) => item.name === 'web_fetch')!;
      const output = await tool.execute({ url: 'http://127.0.0.1/private' }, ctx);
      assert.match(output, /private network destinations are not allowed/i);
      assert.equal(fetched, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('propagates run cancellation instead of turning it into a fallback error', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.BROWSERBASE_API_KEY = 'bb-key';
    process.env.BROWSERBASE_PROJECT_ID = 'bb-project';
    const controller = new AbortController();
    controller.abort();
    const { ctx, directory } = context();
    ctx.signal = controller.signal;
    try {
      const tool = researchTools.find((item) => item.name === 'web_search')!;
      await assert.rejects(tool.execute({ query: 'cancelled' }, ctx));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not create Browserbase fallback sessions inside research subagents', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.BROWSERBASE_API_KEY = 'bb-key';
    process.env.BROWSERBASE_PROJECT_ID = 'bb-project';
    let usedBrowser = false;
    browserService.search = async () => {
      usedBrowser = true;
      return [];
    };
    const { ctx, directory } = context();
    ctx.allowBrowserFallback = false;
    try {
      const tool = researchTools.find((item) => item.name === 'web_search')!;
      const output = await tool.execute({ query: 'subagent' }, ctx);
      assert.equal(usedBrowser, false);
      assert.match(output, /FIRECRAWL_API_KEY is not set/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses Browserbase image search when Firecrawl is unavailable', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.BROWSERBASE_API_KEY = 'bb-key';
    process.env.BROWSERBASE_PROJECT_ID = 'bb-project';
    browserService.imageSearch = async () => [{
      title: 'Rendered image',
      imageUrl: 'https://example.com/image.png',
      sourceUrl: 'https://example.com/article',
    }];
    const { ctx, directory } = context();
    try {
      const tool = researchTools.find((item) => item.name === 'image_search')!;
      const output = await tool.execute({ query: 'diagram' }, ctx);
      assert.match(output, /Rendered image/);
      assert.match(output, /imageUrl: https:\/\/example.com\/image.png/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
