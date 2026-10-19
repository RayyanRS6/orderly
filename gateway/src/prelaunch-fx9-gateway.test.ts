import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Supervisor } from './supervisor.js';
import { Store } from './store.js';
import {
  crashRestartDelay,
  pairingTimeoutCode,
  QR_CODES_ENDED,
  reconnectDecision,
  restorable,
  retryPairing,
} from './policy.js';
import {
  expiredPlaceholders,
  holdPlaceholder,
  PLACEHOLDER_LIMIT,
  PLACEHOLDER_STORE_LIMIT,
  PLACEHOLDER_WAIT_MS,
  releasePlaceholder,
} from './inbound.js';
import { PARKED_LOGOUT_CONNECT_MS, PARKED_LOGOUT_MS, LOGOUT_TIMEOUT_MS } from './shutdown.js';
import type { GatewayEvent } from '../../src/shared/whatsapp.js';

const worker = new URL('./fixtures/test-worker.js', import.meta.url);
async function eventually(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for test worker');
    await new Promise((r) => setTimeout(r, 25));
  }
}
function setup(maxSessions = 10) {
  const dataDir = mkdtempSync(join(tmpdir(), 'orderly-fx9-'));
  const config = {
    secret: 'test-secret-with-at-least-32-characters',
    key: Buffer.alloc(32, 5),
    eventsUrl: 'https://invalid.invalid',
    port: 8080,
    maxSessions,
    dataDir,
    version: undefined,
  };
  return { dataDir, config, log: join(dataDir, 'stops.log') };
}
type Stored = {
  connectionId: string;
  generation: number;
  status: string;
  errorCode?: string;
  crashes: number;
};
const PAIRED = { me: { id: '923000000001:4@s.whatsapp.net' }, account: { details: 'signed' } };
function seedCreds(dataDir: string, key: Buffer, connectionId: string, creds: unknown) {
  const store = new Store(join(dataDir, `${connectionId}.sqlite`), key);
  store.set('auth', 'creds', creds);
  store.close();
}
const authRows = (dataDir: string, key: Buffer, connectionId: string) => {
  const store = new Store(join(dataDir, `${connectionId}.sqlite`), key);
  try {
    return store.count('auth');
  } finally {
    store.close();
  }
};
const lines = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split(' '))
    : [];
const send = (supervisor: Supervisor, session: object, text: string) =>
  supervisor.send({
    ...session,
    peer: '923000000000@s.whatsapp.net',
    text,
    idempotencyKey: randomUUID(),
    lastInboundAt: new Date().toISOString(),
  });
// The supervisor's log lines (codes and connection IDs only), while a test runs.
function captureLogs() {
  const original = console.info;
  const events: { event: string; connectionId?: string }[] = [];
  console.info = (line: string) => events.push(JSON.parse(line));
  return { events, restore: () => (console.info = original) };
}

// gateway-3: the 5-minute pairing timer no longer replaces a refusal WhatsApp gave.
test('a pairing WhatsApp refused ends with its own code, not PAIRING_EXPIRED', () => {
  for (const code of [403, 405, 411, 440]) {
    assert.equal(reconnectDecision(code, 1).action, 'stop', String(code));
    assert.deepEqual(pairingTimeoutCode('error', `DISCONNECT_${code}`), {
      code: `DISCONNECT_${code}`,
      keepStatus: true,
    });
  }
  assert.deepEqual(pairingTimeoutCode('logged_out', 'LOGGED_OUT'), {
    code: 'LOGGED_OUT',
    keepStatus: true,
  });
  // Still waiting for the owner, or retrying a passing failure: the pairing expired.
  for (const [status, errorCode] of [
    ['awaiting_pairing', undefined],
    ['connecting', undefined],
    ['reconnecting', 'DISCONNECT_428'],
    ['error', undefined],
  ] as const)
    assert.deepEqual(pairingTimeoutCode(status, errorCode), {
      code: 'PAIRING_EXPIRED',
      keepStatus: false,
    });
});

test('a refused pairing keeps its code in Orderly and the logs, and is not restarted', async () => {
  const { dataDir, config } = setup();
  const logs = captureLogs();
  const supervisor = new Supervisor(config, worker);
  const session = { connectionId: randomUUID(), generation: 1 };
  try {
    await supervisor.command({ ...session, action: 'pair', method: 'qr' });
    await eventually(() => supervisor.status(session).status === 'connected');
    await assert.rejects(send(supervisor, session, 'simulate-refused'), /SEND_UNCERTAIN/);
    await eventually(
      () => supervisor.store.get<Stored>('sessions', session.connectionId)?.crashes === 1,
    );
    assert.equal(supervisor.status(session).errorCode, 'DISCONNECT_405');
    assert.equal(
      supervisor.store.get<GatewayEvent>('events', session.connectionId)?.errorCode,
      'DISCONNECT_405',
    );
    // Logged once, although both the status and the worker's exit carried it.
    assert.deepEqual(
      logs.events.filter((e) => e.event === 'DISCONNECT_405').map((e) => e.connectionId),
      [session.connectionId],
    );
    assert.equal(logs.events.filter((e) => e.event === 'PAIRING_EXPIRED').length, 0);
    await new Promise((r) => setTimeout(r, crashRestartDelay(1, 1) + 500));
    assert.equal(supervisor.health().workers, 0);
    assert.equal(supervisor.status(session).errorCode, 'DISCONNECT_405');
  } finally {
    logs.restore();
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// gateway-7 (1): a network blip during the first QR is not "QR codes ran out".
test('a lost connection while pairing gets the one retry; QR codes that ran out do not', () => {
  assert.equal(retryPairing(408, false, false, 'Connection was lost'), true);
  assert.equal(retryPairing(408, false, false, QR_CODES_ENDED), false);
  // Without a reason a 408 still counts as QR codes that ran out, as before.
  assert.equal(retryPairing(408, false, false), false);
  // Still only one retry, and none once a pairing code was asked for.
  assert.equal(retryPairing(408, true, false, 'Connection was lost'), false);
  assert.equal(retryPairing(408, false, true, 'Connection was lost'), false);
  for (const code of [428, 503, 500, 0]) assert.equal(retryPairing(code, false, false), true);
});

// gateway-7 (4): retire and disconnect log a device out even when no worker runs for it.
test('a session Orderly retired is logged out before it is wiped, even with no worker running', async () => {
  const { dataDir, config, log } = setup();
  process.env.ORDERLY_TEST_STOP_LOG = log;
  const supervisor = new Supervisor(config, worker);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 410 })) as typeof fetch;
  const session: Stored = {
    connectionId: randomUUID(),
    generation: 2,
    status: 'error',
    errorCode: 'SESSION_CRASH',
    crashes: 1,
  };
  try {
    supervisor.store.set('sessions', session.connectionId, session);
    seedCreds(dataDir, config.key, session.connectionId, PAIRED);
    supervisor.store.set('events', session.connectionId, {
      eventId: randomUUID(),
      connectionId: session.connectionId,
      generation: session.generation,
      type: 'status',
      status: 'error',
      errorCode: 'SESSION_CRASH',
      timestamp: new Date().toISOString(),
    });
    await supervisor.flushEvents();
    await eventually(() => authRows(dataDir, config.key, session.connectionId) === 0);
    // A short-lived worker logged the device out while the credentials were still there.
    assert.deepEqual(lines(log), [[session.connectionId, 'logout-only', '1']]);
    assert.equal(supervisor.status(session).status, 'disconnected');
    assert.equal(supervisor.health().workers, 0);
  } finally {
    globalThis.fetch = original;
    delete process.env.ORDERLY_TEST_STOP_LOG;
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a disconnect or new pairing of a parked session logs its device out first; an unfinished pairing is only wiped', async () => {
  const { dataDir, config, log } = setup(1);
  process.env.ORDERLY_TEST_STOP_LOG = log;
  const logs = captureLogs();
  const supervisor = new Supervisor(config, worker);
  const parked = (errorCode: string): Stored => ({
    connectionId: randomUUID(),
    generation: 1,
    status: 'error',
    errorCode,
    crashes: 0,
  });
  const waiting = parked('SESSION_CAPACITY_REACHED');
  const refused = parked('DISCONNECT_405');
  const unfinished = parked('PAIRING_EXPIRED');
  try {
    for (const session of [waiting, refused, unfinished])
      supervisor.store.set('sessions', session.connectionId, session);
    seedCreds(dataDir, config.key, waiting.connectionId, PAIRED);
    seedCreds(dataDir, config.key, refused.connectionId, PAIRED);
    // An unfinished phone-code pairing holds only the restaurant's number.
    seedCreds(dataDir, config.key, unfinished.connectionId, {
      me: { id: '923000000001@s.whatsapp.net' },
    });

    const next = ({ connectionId }: Stored) => ({ connectionId, generation: 2 });
    await supervisor.command({ ...next(waiting), action: 'disconnect' });
    await supervisor.command({ ...next(unfinished), action: 'disconnect' });
    await supervisor.command({ ...next(refused), action: 'pair', method: 'qr' });
    assert.deepEqual(lines(log), [
      [waiting.connectionId, 'logout-only', '1'],
      [refused.connectionId, 'logout-only', '1'],
    ]);
    for (const session of [waiting, unfinished])
      assert.equal(authRows(dataDir, config.key, session.connectionId), 0);
    // The new pairing starts after its old device was logged out and wiped.
    await eventually(() => supervisor.status(next(refused)).status === 'connected');
    assert.equal(supervisor.health().workers, 1);
    // The operator can see in the logs that each disconnected session is gone.
    assert.deepEqual(
      logs.events.filter((e) => e.event === 'SESSION_DISCONNECTED').map((e) => e.connectionId),
      [waiting.connectionId, unfinished.connectionId],
    );
  } finally {
    logs.restore();
    delete process.env.ORDERLY_TEST_STOP_LOG;
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the logout of a session without a worker fits inside the backend’s 20 s wait', () => {
  assert.ok(PARKED_LOGOUT_CONNECT_MS + LOGOUT_TIMEOUT_MS < PARKED_LOGOUT_MS);
  assert.ok(PARKED_LOGOUT_MS <= 12000);
});

// gateway-7 (3): a crashed worker's restart never takes more places than GATEWAY_MAX_SESSIONS.
test('a crashed worker whose place was taken meanwhile waits for one instead of exceeding the limit', async () => {
  const { dataDir, config } = setup(1);
  const supervisor = new Supervisor(config, worker);
  const running = { connectionId: randomUUID(), generation: 1 };
  const waiting: Stored = {
    connectionId: randomUUID(),
    generation: 1,
    status: 'error',
    errorCode: 'SESSION_CAPACITY_REACHED',
    crashes: 0,
  };
  try {
    await supervisor.command({ ...running, action: 'pair', method: 'qr' });
    await eventually(() => supervisor.status(running).status === 'connected');
    supervisor.store.set('sessions', waiting.connectionId, waiting);
    seedCreds(dataDir, config.key, waiting.connectionId, PAIRED);
    await assert.rejects(send(supervisor, running, 'simulate-crash'), /SEND_UNCERTAIN/);
    await eventually(
      () => supervisor.store.get<Stored>('sessions', running.connectionId)?.crashes === 1,
    );
    // Before the crashed worker's restart, the waiting number takes the free place (any
    // disconnect admits waiting numbers at once).
    await supervisor.command({ connectionId: randomUUID(), generation: 1, action: 'disconnect' });
    await eventually(() => supervisor.status(waiting).status === 'connected');
    await new Promise((r) => setTimeout(r, crashRestartDelay(1, 1) + 500));
    assert.equal(supervisor.health().workers, 1);
    assert.equal(supervisor.status(running).errorCode, 'SESSION_CAPACITY_REACHED');
    assert.equal(restorable('error', 'SESSION_CAPACITY_REACHED'), true);
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// gateway-7 (2): messages staff were already told about no longer use up the waiting limit.
test('a day of unreadable messages staff were told about does not stop new ones being held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-fx9-inbound-'));
  const store = new Store(join(dir, 'session.sqlite'), Buffer.alloc(32, 6));
  const connection = { connectionId: randomUUID(), generation: 1 };
  const now = Date.now();
  try {
    for (let i = 0; i < PLACEHOLDER_LIMIT; i++)
      holdPlaceholder(store, `old-${i}`, '100000001@lid', now - 60000, now - 60000);
    // At the limit, a new one waits only once others are released.
    holdPlaceholder(store, 'new-1', '100000001@lid', now, now);
    assert.equal(store.get('placeholder', 'new-1'), undefined);
    const due = expiredPlaceholders(store, now - 60000 + PLACEHOLDER_WAIT_MS);
    assert.equal(due.length, PLACEHOLDER_LIMIT);
    for (const { id, value } of due)
      releasePlaceholder(store, { ...connection, id, placeholder: value }, now);
    holdPlaceholder(store, 'new-1', '100000001@lid', now, now);
    assert.ok(store.get('placeholder', 'new-1'));
    // Released ones stay, to file a late copy in the same chat.
    assert.equal(store.count('placeholder'), PLACEHOLDER_LIMIT + 1);
    assert.ok(PLACEHOLDER_STORE_LIMIT > PLACEHOLDER_LIMIT);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
