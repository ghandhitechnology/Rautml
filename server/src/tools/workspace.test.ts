import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ToolCtx } from '../types.js';
import { workspaceTools } from './workspace.js';

const bashTool = workspaceTools.find((t) => t.name === 'bash_tool')!;

function tmpCtx(signal?: AbortSignal): { ctx: ToolCtx; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'rautml-bash-test-'));
  const ctx: ToolCtx = {
    chatId: 'test',
    runId: 'test',
    thread: 'main',
    workspaceDir: dir,
    messageId: 'test',
    signal,
    emit: () => {},
  };
  return { ctx, dir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('bash_tool', () => {
  it('runs a command and returns combined stdout', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const out = await bashTool.execute({ command: 'echo hello' }, ctx);
      assert.equal(out.trim(), 'hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty command', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const out = await bashTool.execute({ command: '   ' }, ctx);
      assert.match(out, /^ERROR:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stopped run kills the whole process group, not just the shell', async () => {
    const controller = new AbortController();
    const { ctx, dir } = tmpCtx(controller.signal);
    const marker = path.join(dir, 'marker');
    try {
      // The backgrounded subshell would outlive a lone-shell kill and write
      // the marker; killing the group (negative pid) takes it down too.
      const pending = bashTool.execute(
        { command: `{ sleep 2; touch "${marker}"; } & wait` },
        ctx,
      );
      await sleep(150);
      controller.abort();
      const out = await pending;
      assert.match(out, /run stopped/);
      // Give the orphaned subshell every chance to fire if it survived.
      await sleep(2500);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not spawn at all when the run is already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, dir } = tmpCtx(controller.signal);
    try {
      const out = await bashTool.execute({ command: 'touch should-not-exist' }, ctx);
      assert.match(out, /run stopped/);
      assert.equal(existsSync(path.join(dir, 'should-not-exist')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
