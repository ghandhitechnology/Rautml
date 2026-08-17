import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ToolCtx } from '../types.js';
import {
  browserTools,
  BrowserService,
  createBrowserTools,
  validatePublicBrowserUrl,
  validatePublicFetchUrl,
  type BrowserConnection,
  type BrowserDriver,
} from './browser.js';

function snapshot(url = 'https://example.com/') {
  return {
    url,
    title: 'Example',
    text: 'Ready',
    elements: [{ ref: 's1r1', role: 'button', name: 'Continue' }],
  };
}

function fakeDriver(calls: string[]): BrowserDriver {
  return {
    async navigate(url) { calls.push(`navigate:${url}`); return snapshot(url); },
    async observe() { calls.push('observe'); return snapshot(); },
    async click(ref) { calls.push(`click:${ref}`); return snapshot(); },
    async fill(ref, value) { calls.push(`fill:${ref}:${value}`); return snapshot(); },
    async type(ref, value) { calls.push(`type:${ref}:${value}`); return snapshot(); },
    async press(key, ref) { calls.push(`press:${ref ?? ''}:${key}`); return snapshot(); },
    async select(ref, values) { calls.push(`select:${ref}:${values.join(',')}`); return snapshot(); },
    async setChecked(ref, checked) { calls.push(`checked:${ref}:${checked}`); return snapshot(); },
    async hover(ref) { calls.push(`hover:${ref}`); return snapshot(); },
    async wait(ms) { calls.push(`wait:${ms}`); return snapshot(); },
    async history(direction) { calls.push(`history:${direction}`); return snapshot(); },
    async extract(ref) { calls.push(`extract:${ref ?? ''}`); return 'extracted'; },
    async screenshot(file) { calls.push(`screenshot:${file}`); await writeFile(file, 'png'); },
    async upload(ref, files) { calls.push(`upload:${ref}:${files.length}`); return snapshot(); },
    async triggerDownload(ref) {
      calls.push(`download:${ref}`);
      return { suggestedFilename: 'report.csv', snapshot: snapshot() };
    },
    async tabs() { calls.push('tabs'); return [{ index: 0, active: true, title: 'Example', url: 'https://example.com/' }]; },
    async newTab(url) { calls.push(`new-tab:${url ?? ''}`); return snapshot(url); },
    async switchTab(index) { calls.push(`switch:${index}`); return snapshot(); },
    async closeTab(index) { calls.push(`close-tab:${index ?? ''}`); return snapshot(); },
    async search(query) { calls.push(`search:${query}`); return [{ title: 'Result', url: 'https://example.com', snippet: 'Found' }]; },
    async imageSearch(query) { calls.push(`images:${query}`); return [{ title: 'Image', imageUrl: 'https://example.com/a.png', sourceUrl: 'https://example.com' }]; },
    async fetchPage(url) { calls.push(`fetch:${url}`); return '# Page'; },
    async close() { calls.push('driver-close'); },
  };
}

function ctx(runId: string, workspaceDir: string, signal?: AbortSignal): ToolCtx {
  return {
    chatId: 'chat',
    runId,
    thread: 'main',
    workspaceDir,
    messageId: 'message',
    signal,
    emit() {},
  };
}

const live = process.env.RAUTML_BROWSERBASE_LIVE_TEST === '1';

it('connects to a live Browserbase session', { skip: !live }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rautml-browser-live-'));
  const controller = new AbortController();
  try {
    const output = await browserTools[0]!.execute(
      { action: 'navigate', url: 'https://example.com' },
      ctx(`live-${Date.now()}`, directory, controller.signal),
    );
    assert.match(output, /Example Domain/);
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('browser URL policy', () => {
  it('accepts public HTTP(S) URLs', () => {
    assert.equal(validatePublicBrowserUrl('https://example.com/path'), 'https://example.com/path');
  });

  it('rejects local schemes, credentials, and private literal addresses', () => {
    for (const url of [
      'file:///etc/passwd',
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://10.1.2.3',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[::ffff:7f00:1]',
      'http://[::ffff:10.0.0.5]',
      'http://[::ffff:0a00:5]',
      'https://user:secret@example.com',
    ]) {
      assert.throws(() => validatePublicBrowserUrl(url));
    }
  });

  it('rejects hostnames that resolve to a private address', async () => {
    await assert.rejects(validatePublicFetchUrl('http://localhost/private'), /private network/i);
  });
});

describe('BrowserService', () => {
  it('reuses one session within a run and separates different runs', async () => {
    const calls: string[] = [];
    let connected = 0;
    const service = new BrowserService(async () => {
      connected += 1;
      const driver = fakeDriver(calls);
      return {
        driver,
        sessionId: `session-${connected}`,
        isAlive: () => true,
        async prepareUploads(files) { return files; },
        async saveDownloads() { return []; },
        async release() { calls.push(`release:${connected}`); },
      } satisfies BrowserConnection;
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'rautml-browser-'));
    try {
      const first = await service.get(ctx('run-1', directory));
      const again = await service.get(ctx('run-1', directory));
      const other = await service.get(ctx('run-2', directory));
      assert.equal(first, again);
      assert.notEqual(first, other);
      assert.equal(connected, 2);
      await service.closeAll();
      assert.equal(calls.filter((call) => call.startsWith('release:')).length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caps global concurrency and allows another run after release', async () => {
    const service = new BrowserService(async () => ({
      driver: fakeDriver([]),
      sessionId: 'session',
      isAlive: () => true,
      async prepareUploads(files) { return files; },
      async saveDownloads() { return []; },
      async release() {},
    }));
    const directory = await mkdtemp(path.join(tmpdir(), 'rautml-browser-'));
    try {
      await Promise.all([1, 2].map((run) => service.get(ctx(`run-${run}`, directory))));
      await assert.rejects(service.get(ctx('run-3', directory)), /2 sessions are already active/);
      await service.finish('run-1');
      await service.get(ctx('run-3', directory));
      await service.closeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases the session when the run is aborted', async () => {
    let releases = 0;
    const service = new BrowserService(async () => ({
      driver: fakeDriver([]),
      sessionId: 'session',
      isAlive: () => true,
      async prepareUploads(files) { return files; },
      async saveDownloads() { return []; },
      async release() { releases += 1; },
    }));
    const controller = new AbortController();
    const directory = await mkdtemp(path.join(tmpdir(), 'rautml-browser-'));
    try {
      await service.get(ctx('run', directory, controller.signal));
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(releases, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('replaces a session that died mid-run instead of returning a corpse', async () => {
    const calls: string[] = [];
    let connected = 0;
    const service = new BrowserService(async () => {
      connected += 1;
      const generation = connected;
      return {
        driver: fakeDriver([]),
        sessionId: `session-${generation}`,
        // The first cached session is already dead (lifetime cap / CDP drop).
        isAlive: () => generation === 2,
        async prepareUploads(files) { return files; },
        async saveDownloads() { return []; },
        async release() { calls.push(`release:${generation}`); },
      } satisfies BrowserConnection;
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'rautml-browser-'));
    try {
      const connection = await service.get(ctx('run', directory));
      assert.equal(connection.sessionId, 'session-2');
      assert.ok(calls.includes('release:1'));
      await service.closeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('browser tool', () => {
  it('dispatches actions and writes artifacts only inside the workspace', async () => {
    const calls: string[] = [];
    const service = new BrowserService(async () => ({
      driver: fakeDriver(calls),
      sessionId: 'session',
      isAlive: () => true,
      async prepareUploads(files) { calls.push(`prepare:${files.length}`); return files; },
      async saveDownloads(directory, suggestedFilename) {
        const file = path.join(directory, suggestedFilename);
        await writeFile(file, 'a,b\n1,2\n');
        return [file];
      },
      async release() { calls.push('release'); },
    }));
    const tool = createBrowserTools(service)[0]!;
    const directory = await mkdtemp(path.join(tmpdir(), 'rautml-browser-'));
    try {
      const context = ctx('run', directory);
      const opened = await tool.execute({ action: 'navigate', url: 'https://example.com' }, context);
      assert.match(opened, /\[s1r1\] button "Continue"/);
      await tool.execute({ action: 'fill', ref: 's1r1', value: 'hello' }, context);
      await tool.execute({ action: 'screenshot', path: 'shots/page.png' }, context);
      assert.equal(await readFile(path.join(directory, 'shots/page.png'), 'utf8'), 'png');
      const uploadFile = path.join(directory, 'upload.txt');
      await writeFile(uploadFile, 'hello');
      await tool.execute({ action: 'upload', ref: 's1r1', paths: ['upload.txt'] }, context);
      const downloaded = await tool.execute({ action: 'download', ref: 's1r1' }, context);
      assert.match(downloaded, /downloads\/report\.csv/);
      await assert.rejects(
        tool.execute({ action: 'screenshot', path: '../escape.png' }, context),
        /inside the chat workspace/,
      );
      assert.deepEqual(calls.slice(0, 6), [
        'navigate:https://example.com',
        'fill:s1r1:hello',
        `screenshot:${path.join(directory, 'shots/page.png')}`,
        'prepare:1',
        'upload:s1r1:1',
        'download:s1r1',
      ]);
      await tool.execute({ action: 'close' }, context);
      assert.equal(calls.at(-1), 'release');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
