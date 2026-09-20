import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Supervisor } from './supervisor.js';

async function eventually(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for test worker');
    await new Promise((r) => setTimeout(r, 25));
  }
}
test('ten isolated processes, capacity control, crash containment, generation fences and restart recovery', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orderly-supervisor-test-'));
  const config = {
    secret: 'test-secret-with-at-least-32-characters',
    key: Buffer.alloc(32, 1),
    eventsUrl: 'https://invalid.invalid',
    port: 8080,
    maxSessions: 10,
    dataDir,
    version: undefined,
  };
  let supervisor = new Supervisor(config, new URL('./fixtures/test-worker.js', import.meta.url));
  const sessions = Array.from({ length: 10 }, () => ({
    connectionId: randomUUID(),
    generation: 1,
  }));
  try {
    for (const s of sessions) await supervisor.command({ ...s, action: 'pair', method: 'qr' });
    await eventually(() => sessions.every((s) => supervisor.status(s).status === 'connected'));
    assert.equal(supervisor.health().workers, 10);
    await assert.rejects(
      supervisor.command({
        connectionId: randomUUID(),
        generation: 1,
        action: 'pair',
        method: 'qr',
      }),
      /SESSION_CAPACITY_REACHED/,
    );
    const send = (index: number, text: string) =>
      supervisor.send({
        ...sessions[index],
        peer: '923000000000@s.whatsapp.net',
        text,
        idempotencyKey: randomUUID(),
        lastInboundAt: new Date().toISOString(),
      });
    await assert.rejects(send(0, 'simulate-crash'), /SEND_UNCERTAIN/);
    assert.equal(supervisor.status(sessions[1]).status, 'connected');
    assert.ok(await send(1, 'still connected'));
    const bumped = { ...sessions[0], generation: 2 };
    await supervisor.command({ ...bumped, action: 'disconnect' });
    assert.throws(() => supervisor.status(sessions[0]), /STALE_GENERATION/);
    await assert.rejects(
      supervisor.command({ ...sessions[0], action: 'pair', method: 'qr' }),
      /STALE_GENERATION/,
    );
    assert.equal(supervisor.status(bumped).status, 'disconnected');
    await supervisor.close();
    supervisor = new Supervisor(config, new URL('./fixtures/test-worker.js', import.meta.url));
    supervisor.restore();
    await eventually(() =>
      sessions.slice(1).every((s) => supervisor.status(s).status === 'connected'),
    );
    assert.equal(supervisor.health().workers, 9);
    assert.equal(supervisor.status(bumped).status, 'disconnected');
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
