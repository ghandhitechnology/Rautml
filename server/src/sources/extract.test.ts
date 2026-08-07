import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractText, extractTextInProcess } from './extract.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'rautml-extract-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('extractText worker dispatch', () => {
  it('extracts plain text through the worker', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'note.md');
      await fs.writeFile(file, 'hello world\n\nsecond paragraph\n');
      assert.equal(await extractText(file, 'md'), 'hello world\n\nsecond paragraph');
    });
  });

  it('propagates extraction failures out of the worker', async () => {
    await assert.rejects(extractText('/does/not/exist', 'exe'), /Unsupported file type/);
  });

  it('falls back cleanly when a job fails inside the worker', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'missing.md');
      await assert.rejects(extractText(file, 'md'), /ENOENT/);
      // the worker survives a failed job and keeps serving the next one
      const ok = path.join(dir, 'ok.md');
      await fs.writeFile(ok, 'still alive');
      assert.equal(await extractText(ok, 'md'), 'still alive');
    });
  });
});

describe('binary parse byte cap', () => {
  it('rejects oversize binary files without parsing them', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'huge.pdf');
      await fs.writeFile(file, '');
      // Sparse file: the size is real to stat() but costs no disk or memory.
      await fs.truncate(file, 150 * 1024 * 1024);
      await assert.rejects(extractTextInProcess(file, 'pdf'), /too large to parse/);
      await assert.rejects(extractText(file, 'pdf'), /too large to parse/);
    });
  });

  it('still parses (and fails on content, not size) for small binary files', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'broken.pdf');
      await fs.writeFile(file, 'this is not a real pdf');
      await assert.rejects(
        extractTextInProcess(file, 'pdf'),
        (err: Error) => !/too large to parse/.test(err.message),
      );
    });
  });
});

describe('readPlainText', () => {
  it('reads the whole file and caps at 48MB with a truncation note', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'big.md');
      const body = 'lorem ipsum dolor sit amet, consectetur adipiscing elit\n';
      const size = 48 * 1024 * 1024 + body.length * 10;
      await fs.writeFile(file, body.repeat(Math.ceil(size / body.length)).slice(0, size));

      const text = await extractText(file, 'md');
      assert.ok(text.length > 0);
      assert.ok(text.length < size);
      assert.ok(text.endsWith('[…extraction truncated: the file continues beyond this point…]'));
    });
  });
});
