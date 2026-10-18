import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'orderly-prelaunch-d-'));
  const config = {
    secret: 'test-secret-with-at-least-32-characters',
    key: Buffer.alloc(32, 3),
    eventsUrl: 'https://invalid.invalid',
    port: 8080,
    maxSessions: 10,
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

// F04: sessions an older gateway parked in 'error' after a passing failure come back on the
// next deploy by themselves; refused or logged-out ones wait for the owner.
test('restore revives sessions stuck after passing failures and leaves refused ones alone', async () => {
  const { dataDir, config } = setup();
  const sessions: Record<string, Stored> = {};
  for (const [status, errorCode, crashes] of [
    ['error', 'RECONNECT_EXHAUSTED', 0],
    ['error', 'SESSION_CRASH', 6],
    ['error', 'DISCONNECT_500', 0],
    ['error', 'DISCONNECT_0', 0],
    ['error', 'DISCONNECT_440', 0],
    ['error', 'DISCONNECT_403', 0],
    ['error', 'DISCONNECT_405', 0],
    ['error', 'INVALID_ACCOUNT_IDENTITY', 0],
    ['logged_out', 'LOGGED_OUT', 0],
  ] as const) {
    const session = { connectionId: randomUUID(), generation: 1, status, errorCode, crashes };
    sessions[errorCode] = session;
  }
  let supervisor = new Supervisor(config, worker);
  for (const session of Object.values(sessions))
    supervisor.store.set('sessions', session.connectionId, session);
  await supervisor.close();
  supervisor = new Supervisor(config, worker);
  try {
    supervisor.restore();
    const revived = ['RECONNECT_EXHAUSTED', 'SESSION_CRASH', 'DISCONNECT_500', 'DISCONNECT_0'];
    await eventually(() =>
      revived.every((code) => supervisor.status(sessions[code]!).status === 'connected'),
    );
    assert.equal(supervisor.health().workers, revived.length);
    for (const code of ['DISCONNECT_440', 'DISCONNECT_403', 'DISCONNECT_405'])
      assert.equal(supervisor.status(sessions[code]!).errorCode, code);
    assert.equal(supervisor.status(sessions.INVALID_ACCOUNT_IDENTITY!).status, 'error');
    assert.equal(supervisor.status(sessions.LOGGED_OUT!).status, 'logged_out');
    // Six earlier crashes still count until the session has stayed connected for a while.
    const crashed = supervisor.store.get<Stored>('sessions', sessions.SESSION_CRASH!.connectionId);
    assert.equal(crashed?.crashes, 6);
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a session that stays connected has its crash count forgiven, so restarts stay quick', async () => {
  const { dataDir, config } = setup();
  const session: Stored = {
    connectionId: randomUUID(),
    generation: 1,
    status: 'error',
    errorCode: 'SESSION_CRASH',
    crashes: 9,
  };
  // Healthy at once instead of after ten minutes, to keep the test fast.
  const supervisor = new Supervisor(config, worker, 0);
  try {
    supervisor.store.set('sessions', session.connectionId, session);
    supervisor.restore();
    await eventually(
      () => supervisor.store.get<Stored>('sessions', session.connectionId)?.status === 'connected',
    );
    assert.equal(supervisor.store.get<Stored>('sessions', session.connectionId)?.crashes, 0);
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a crashed worker is restarted with its real failure code kept for Orderly', async () => {
  const { dataDir, config } = setup();
  const supervisor = new Supervisor(config, worker);
  const session = { connectionId: randomUUID(), generation: 1 };
  try {
    await supervisor.command({ ...session, action: 'pair', method: 'qr' });
    await eventually(() => supervisor.status(session).status === 'connected');
    await assert.rejects(
      supervisor.send({
        ...session,
        peer: '923000000000@s.whatsapp.net',
        text: 'simulate-fatal',
        idempotencyKey: randomUUID(),
        lastInboundAt: new Date().toISOString(),
      }),
      /SEND_UNCERTAIN/,
    );
    await eventually(
      () => supervisor.store.get<Stored>('sessions', session.connectionId)?.crashes === 1,
    );
    const stored = supervisor.store.get<Stored>('sessions', session.connectionId);
    assert.equal(stored?.errorCode, 'INBOUND_QUEUE_FULL');
    // The queued status event carries the same code.
    const queued = supervisor.store.get<{ errorCode?: string }>('events', session.connectionId);
    assert.equal(queued?.errorCode, 'INBOUND_QUEUE_FULL');
    // ...and the worker comes back by itself.
    await eventually(() => supervisor.status(session).status === 'connected');
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// F24: set-aside customer messages hold message text, so a disconnect or new pairing wipes
// them like the rest of the session's queue.
const SESSION_NAMESPACES = [
  'events',
  'dead-events',
  'route',
  'identity',
  'seen',
  'seen-id',
  'placeholder',
];
test('disconnecting clears set-aside messages together with the queue', async () => {
  const { dataDir, config } = setup();
  const supervisor = new Supervisor(config, worker);
  const session = { connectionId: randomUUID(), generation: 1 };
  try {
    await supervisor.command({ ...session, action: 'pair', method: 'qr' });
    await eventually(() => supervisor.status(session).status === 'connected');
    const path = join(dataDir, `${session.connectionId}.sqlite`);
    const sessionStore = new Store(path, config.key);
    for (const namespace of SESSION_NAMESPACES) sessionStore.set(namespace, 'row', { text: 'x' });
    sessionStore.close();
    await supervisor.command({ ...session, generation: 2, action: 'disconnect' });
    const after = new Store(path, config.key);
    for (const namespace of SESSION_NAMESPACES) assert.equal(after.count(namespace), 0, namespace);
    after.close();
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
