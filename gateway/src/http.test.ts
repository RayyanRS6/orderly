import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { signedHeaders } from '../../server/whatsapp/signing.js';

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
  } finally {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
