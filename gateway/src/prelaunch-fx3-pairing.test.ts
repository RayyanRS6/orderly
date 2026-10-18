import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Supervisor } from './supervisor.js';
import { Store } from './store.js';
import { crashRestartDelay, restorable, retryPairing } from './policy.js';
import { logsOut } from './shutdown.js';
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

// gateway-2: an abandoned pairing ends instead of opening new WhatsApp registrations for ever.
test('a pairing nobody finished gets at most one retry, and none once its QR codes ran out', () => {
  assert.equal(retryPairing(408, false, false), false);
  for (const code of [428, 503, 500, 0]) {
    assert.equal(retryPairing(code, false, false), true, String(code));
    assert.equal(retryPairing(code, true, false), false, String(code));
    // After a pairing code was asked for, a retry would log in as the restaurant's number.
    assert.equal(retryPairing(code, false, true), false, String(code));
  }
  assert.equal(restorable('error', 'PAIRING_EXPIRED'), false);
});

test('restore never revives a pairing nobody finished, from this or an older gateway', async () => {
  const { dataDir, config } = setup();
  const unpaired: Stored[] = [
    ['error', 'RECONNECT_EXHAUSTED'],
    ['reconnecting', 'DISCONNECT_408'],
    ['connecting', undefined],
    ['error', 'DISCONNECT_428'],
    ['error', 'SESSION_CRASH'],
  ].map(([status, errorCode]) => ({
    connectionId: randomUUID(),
    generation: 1,
    status: status!,
    errorCode,
    crashes: 0,
  }));
  const codeOnly = { ...unpaired[0]!, connectionId: randomUUID() };
  const paired = { ...unpaired[0]!, connectionId: randomUUID() };
  let supervisor = new Supervisor(config, worker);
  for (const session of [...unpaired, codeOnly, paired])
    supervisor.store.set('sessions', session.connectionId, session);
  await supervisor.close();
  // One saved an unfinished phone-code pairing, one a finished pairing; the rest saved nothing.
  seedCreds(dataDir, config.key, codeOnly.connectionId, {
    me: { id: '923000000001@s.whatsapp.net' },
  });
  seedCreds(dataDir, config.key, paired.connectionId, PAIRED);
  supervisor = new Supervisor(config, worker);
  try {
    supervisor.restore();
    await eventually(() => supervisor.status(paired).status === 'connected');
    assert.equal(supervisor.health().workers, 1);
    for (const session of [...unpaired, codeOnly]) {
      const stored = supervisor.store.get<Stored>('sessions', session.connectionId);
      assert.equal(stored?.status, 'error');
      assert.equal(stored?.errorCode, 'PAIRING_EXPIRED');
      // Orderly is told, so the dashboard asks for a new pairing.
      const queued = supervisor.store.get<GatewayEvent>('events', session.connectionId);
      assert.equal(queued?.errorCode, 'PAIRING_EXPIRED');
    }
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a worker whose pairing expired is not restarted, and Orderly is told', async () => {
  const { dataDir, config } = setup();
  const supervisor = new Supervisor(config, worker);
  const session = { connectionId: randomUUID(), generation: 1 };
  try {
    await supervisor.command({ ...session, action: 'pair', method: 'qr' });
    await eventually(() => supervisor.status(session).status === 'connected');
    await assert.rejects(send(supervisor, session, 'simulate-pairing-expired'), /SEND_UNCERTAIN/);
    await eventually(
      () =>
        supervisor.store.get<Stored>('sessions', session.connectionId)?.errorCode ===
        'PAIRING_EXPIRED',
    );
    assert.equal(
      supervisor.store.get<GatewayEvent>('events', session.connectionId)?.errorCode,
      'PAIRING_EXPIRED',
    );
    // Longer than the first crash restart would wait: the place stays free.
    await new Promise((r) => setTimeout(r, crashRestartDelay(1, 1) + 500));
    assert.equal(supervisor.health().workers, 0);
    assert.equal(supervisor.status(session).errorCode, 'PAIRING_EXPIRED');
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restore keeps to the session limit, connected numbers first, and starts the rest when a place frees', async () => {
  const { dataDir, config } = setup(1);
  // Saved first, so without the ordering it would take the only place.
  const waiting: Stored = {
    connectionId: randomUUID(),
    generation: 1,
    status: 'reconnecting',
    errorCode: 'DISCONNECT_428',
    crashes: 0,
  };
  const working: Stored = { ...waiting, connectionId: randomUUID(), status: 'connected' };
  let supervisor = new Supervisor(config, worker);
  for (const session of [waiting, working])
    supervisor.store.set('sessions', session.connectionId, session);
  await supervisor.close();
  for (const session of [waiting, working])
    seedCreds(dataDir, config.key, session.connectionId, PAIRED);
  supervisor = new Supervisor(config, worker);
  try {
    supervisor.restore();
    await eventually(() => supervisor.status(working).status === 'connected');
    assert.equal(supervisor.health().workers, 1);
    assert.equal(supervisor.status(waiting).errorCode, 'SESSION_CAPACITY_REACHED');
    assert.equal(restorable('error', 'SESSION_CAPACITY_REACHED'), true);
    await supervisor.command({
      connectionId: working.connectionId,
      generation: 2,
      action: 'disconnect',
    });
    await eventually(() => supervisor.status(waiting).status === 'connected');
    assert.equal(supervisor.health().workers, 1);
  } finally {
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// gateway-9 (d): only a finished pairing is logged out on disconnect or new pairing.
test('a stop only logs out a device that finished pairing', () => {
  assert.equal(logsOut(true, PAIRED), true);
  // An unfinished phone-code pairing: the restaurant's number, no signed account.
  assert.equal(logsOut(true, { account: undefined }), false);
  assert.equal(logsOut(true, undefined), false);
  assert.equal(logsOut(false, PAIRED), false);
});
