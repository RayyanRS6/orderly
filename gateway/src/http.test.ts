import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { signedHeaders } from '../../server/whatsapp/signing.js';
import { probeGateway } from './deployment.js';

test('real HTTP gateway boots without sessions, verifies signatures and blocks replays/browser calls', async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), 'orderly-http-test-'));
  const secret = 'test-gateway-secret-at-least-32-characters';
  const child = fork(new URL('./index.js', import.meta.url), [], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_DATA_DIR: dir,
      GATEWAY_SHARED_SECRET: secret,
      GATEWAY_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      ORDERLY_EVENTS_URL: 'https://invalid.example/events',
    },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(200) })).ok;
      } catch {
        /* bounded startup polling */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, 'gateway did not start');
    assert.deepEqual(await probeGateway(base, secret), { workers: 0, maxSessions: 10 });
    const raw = '{}';
    const headers = signedHeaders(secret, 'command', '/health', raw);
    const health = await fetch(`${base}/health`, { method: 'POST', headers, body: raw });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).workers, 0);
    assert.equal(
      (await fetch(`${base}/health`, { method: 'POST', headers, body: raw })).status,
      401,
    );
    assert.equal((await fetch(`${base}/health`, { method: 'POST', body: raw })).status, 401);
    assert.equal(
      (
        await fetch(`${base}/health`, {
          method: 'POST',
          headers: {
            ...signedHeaders(secret, 'command', '/health', raw),
            Origin: 'https://attacker.example',
          },
          body: raw,
        })
      ).status,
      403,
    );
    const body = JSON.stringify({ connectionId: randomUUID(), generation: 1 });
    const missing = await fetch(`${base}/status`, {
      method: 'POST',
      headers: signedHeaders(secret, 'command', '/status', body),
      body,
    });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).errorCode, 'STALE_GENERATION');
    // Keep below the independent 64-connection cap while flooding.
    const flood = async (request: () => Promise<Response>) => {
      const responses: Response[] = [];
      for (let batch = 0; batch < 10; batch++)
        responses.push(
          ...(await Promise.all(
            Array.from({ length: 20 }, async () => {
              const response = await request();
              await response.arrayBuffer();
              return response;
            }),
          )),
        );
      return responses;
    };
    const timeout = () => AbortSignal.timeout(5000);
    // Unsigned traffic (anyone who finds the hostname) is refused without using the budget.
    const unsigned = await flood(() =>
      fetch(`${base}/send`, { method: 'POST', body: raw, signal: timeout() }),
    );
    assert.ok(unsigned.every((response) => response.status === 401));
    const liveness = await flood(() => fetch(`${base}/healthz`, { signal: timeout() }));
    assert.ok(liveness.every((response) => response.status === 200));
    const signed = (path: string, body = raw) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: signedHeaders(secret, 'command', path, body),
        body,
        signal: timeout(),
      });
    assert.equal((await signed('/health')).status, 200);
    // Orderly's own polling past its budget is slowed down with Retry-After...
    const polls = await flood(() => signed('/health'));
    const busy = polls.filter((response) => response.status === 429);
    assert.ok(busy.length > 0);
    assert.ok(busy.every((response) => response.headers.get('Retry-After') === '1'));
    // ...but never takes the budget sends and pairing commands use.
    const command = await signed('/session');
    assert.equal(command.status, 400);
    assert.equal((await command.json()).errorCode, 'INVALID_INPUT');
    // Liveness and unsigned rejection are unaffected by a busy signed budget.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/status`, { method: 'POST', body: raw })).status, 401);
  } finally {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
