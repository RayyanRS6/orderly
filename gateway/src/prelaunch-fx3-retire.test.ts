import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Supervisor } from './supervisor.js';
import { Store } from './store.js';
const worker = new URL('./fixtures/test-worker.js', import.meta.url);
async function eventually(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for test worker');
    await new Promise((r) => setTimeout(r, 25));
  }
}
function setup(maxSessions = 10) {
  const dataDir = mkdtempSync(join(tmpdir(), 'orderly-fx3-'));
  const config = {
    secret: 'test-secret-with-at-least-32-characters',
    key: Buffer.alloc(32, 9),
    eventsUrl: 'https://invalid.invalid',
    port: 8080,
    maxSessions,
    dataDir,
    version: undefined,
  };
  return { dataDir, config };
}
type Stored = {
  connectionId: string;
  generation: number;
  status: string;
  errorCode?: string;
  crashes: number;
};
// What a session's own database holds: a finished pairing has the account WhatsApp signs, an
// unfinished phone-code pairing only the restaurant's number.
function seedCreds(dataDir: string, key: Buffer, connectionId: string, creds: unknown) {
  const store = new Store(join(dataDir, `${connectionId}.sqlite`), key);
  store.set('auth', 'creds', creds);
  store.close();
}
const PAIRED = { me: { id: '923000000001:4@s.whatsapp.net' }, account: { details: 'signed' } };
const send = (supervisor: Supervisor, session: object, text: string) =>
  supervisor.send({
    ...session,
    peer: '923000000000@s.whatsapp.net',
    text,
    idempotencyKey: randomUUID(),
    lastInboundAt: new Date().toISOString(),
  });

// gateway-4: Orderly answers 410 for a session it no longer uses (the business switched to Meta
// or disconnected while the gateway could not be told); the gateway ends it as a disconnect.
test('a session Orderly no longer uses is logged out, wiped and never revived', async () => {
  const { dataDir, config } = setup();
  const log = join(dataDir, 'stops.log');
  process.env.ORDERLY_TEST_STOP_LOG = log;
  let supervisor = new Supervisor(config, worker);
  const session = { connectionId: randomUUID(), generation: 3 };
  try {
    await supervisor.command({ ...session, action: 'pair', method: 'qr' });
    await eventually(() => supervisor.status(session).status === 'connected');
    const path = join(dataDir, `${session.connectionId}.sqlite`);
    seedCreds(dataDir, config.key, session.connectionId, PAIRED);
    const before = new Store(path, config.key);
    for (const namespace of ['events', 'route', 'identity', 'seen-id', 'placeholder', 'sent'])
      before.set(namespace, 'row', { text: 'x' });
    before.close();
    await send(supervisor, session, 'simulate-stale').catch(() => undefined);
    await eventually(() => supervisor.status(session).status === 'disconnected');
    assert.equal(supervisor.health().workers, 0);
    await eventually(() => existsSync(log) && readFileSync(log, 'utf8').endsWith('\n'));
    // Logged out while the credentials were still on disk, then wiped.
    assert.deepEqual(readFileSync(log, 'utf8').trim().split(' '), [
      session.connectionId,
      'true',
      '1',
    ]);
    const count = (namespace: string) => {
      const after = new Store(path, config.key);
      try {
        return after.count(namespace);
      } finally {
        after.close();
      }
    };
    await eventually(() => count('auth') === 0);
    for (const namespace of ['events', 'route', 'identity', 'seen-id', 'placeholder', 'sent'])
      assert.equal(count(namespace), 0, namespace);
    await supervisor.close();
    supervisor = new Supervisor(config, worker);
    supervisor.restore();
    assert.equal(supervisor.health().workers, 0);
    assert.equal(supervisor.status(session).status, 'disconnected');
  } finally {
    delete process.env.ORDERLY_TEST_STOP_LOG;
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a 410 for a crashed session’s queued status also ends it; other answers keep it', async () => {
  const { dataDir, config } = setup();
  const supervisor = new Supervisor(config, worker);
  const original = globalThis.fetch;
  let answer = 503;
  globalThis.fetch = (async () => new Response(null, { status: answer })) as typeof fetch;
  const session: Stored = {
    connectionId: randomUUID(),
    generation: 2,
    status: 'error',
    errorCode: 'SESSION_CRASH',
    crashes: 1,
  };
  const queue = () =>
    supervisor.store.set('events', session.connectionId, {
      eventId: randomUUID(),
      connectionId: session.connectionId,
      generation: session.generation,
      type: 'status',
      status: 'error',
      errorCode: 'SESSION_CRASH',
      timestamp: new Date().toISOString(),
    });
  try {
    supervisor.store.set('sessions', session.connectionId, session);
    seedCreds(dataDir, config.key, session.connectionId, PAIRED);
    queue();
    await supervisor.flushEvents();
    assert.equal(supervisor.store.count('events'), 1);
    assert.equal(supervisor.status(session).status, 'error');
    answer = 410;
    await supervisor.flushEvents();
    assert.equal(supervisor.store.count('events'), 0);
    await eventually(() => supervisor.status(session).status === 'disconnected');
    const after = new Store(join(dataDir, `${session.connectionId}.sqlite`), config.key);
    await eventually(() => after.count('auth') === 0);
    after.close();
  } finally {
    globalThis.fetch = original;
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
