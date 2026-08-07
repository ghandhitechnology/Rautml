import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// api.ts imports db.ts, which opens the real database at module load; point
// it at a throwaway dir before the (dynamic) import below.
process.env.RAUTML_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'rautml-api-test-'));

const { asyncHandler } = await import('./api.js');

type FakeRes = {
  headersSent: boolean;
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
};

function fakeRes(): FakeRes {
  return {
    headersSent: false,
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

/** asyncHandler answers via .catch — flush the microtask queue to observe it. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('asyncHandler', () => {
  it('lets a resolved handler answer normally', async () => {
    const res = fakeRes();
    asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    })({} as never, res as never);
    await flush();
    assert.deepEqual(res.body, { ok: true });
  });

  it('turns a rejection into a 500 JSON without internals', async () => {
    const res = fakeRes();
    asyncHandler(async () => {
      throw new Error('secret internals: /Users/alice/rautml.db');
    })({ method: 'GET', originalUrl: '/api/x' } as never, res as never);
    await flush();
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error' });
  });

  it('does not double-send when the response is already committed', async () => {
    const res = fakeRes();
    res.headersSent = true;
    asyncHandler(async () => {
      throw new Error('late failure');
    })({ method: 'GET', originalUrl: '/api/z' } as never, res as never);
    await flush();
    assert.equal(res.statusCode, 0);
    assert.equal(res.body, undefined);
  });
});
