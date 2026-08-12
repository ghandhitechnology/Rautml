import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { fetchWithHeadersTimeout } from './http.js';

let server: Server;
let url: string;

/** Routes: /hang never responds; /slow-body sends headers then waits. */
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // writeHead alone buffers until the first body write; flush so the
      // headers genuinely beat the client's deadline.
      res.flushHeaders();
      setTimeout(() => res.end('late body'), 300);
      return;
    }
    // /hang: accept the connection and never send headers.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('fetchWithHeadersTimeout', () => {
  it('rejects with a timeout error when headers never arrive', async () => {
    const started = Date.now();
    await assert.rejects(
      fetchWithHeadersTimeout(`${url}/hang`, {}, 200),
      /timed out after \d+s waiting for response headers/,
    );
    assert.ok(Date.now() - started < 2_000, 'should fail fast, not hang');
  });

  it("propagates the caller's own abort as an AbortError", async () => {
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 50);
    await assert.rejects(fetchWithHeadersTimeout(`${url}/hang`, { signal: caller.signal }, 5_000), {
      name: 'AbortError',
    });
  });

  it('clears the timer once headers arrive, so slow bodies still complete', async () => {
    const res = await fetchWithHeadersTimeout(`${url}/slow-body`, {}, 150);
    assert.equal(res.status, 200);
    // The 150ms header deadline expires while the body is still in flight;
    // reading it must not be killed by the stale timer.
    assert.equal(await res.text(), 'late body');
  });
});
