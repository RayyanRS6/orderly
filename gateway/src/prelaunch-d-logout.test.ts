import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { endSocket } from './shutdown.js';
import { Supervisor } from './supervisor.js';
import { Store } from './store.js';

function fakeSocket(logout: () => Promise<void>) {
  const calls: string[] = [];
  return {
    calls,
    socket: {
      logout: async () => {
        calls.push('logout');
        await logout();
      },
      end: (error: Error | undefined) => {
        calls.push(`end:${error?.message}`);
      },
    },
  };
}

// F26: disconnecting or re-pairing removes the linked device from the restaurant's phone.
test('a revoking stop logs the device out; a plain stop only closes the socket', async () => {
  const revoked = fakeSocket(async () => undefined);
  assert.equal(await endSocket(revoked.socket, true), true);
  assert.deepEqual(revoked.calls, ['logout']);

  const plain = fakeSocket(async () => undefined);
  assert.equal(await endSocket(plain.socket, false), false);
  assert.deepEqual(plain.calls, ['end:STOPPED']);

  assert.equal(await endSocket(undefined, true), false);
});

test('a logout that fails or hangs falls back to closing, within the time limit', async () => {
  const offline = fakeSocket(async () => {
    throw new Error('Connection Closed');
  });
  assert.equal(await endSocket(offline.socket, true), false);
  assert.deepEqual(offline.calls, ['logout', 'end:STOPPED']);

  const hanging = fakeSocket(() => new Promise<void>(() => undefined));
  const started = Date.now();
  assert.equal(await endSocket(hanging.socket, true, 50), false);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(hanging.calls, ['logout', 'end:STOPPED']);
});

test('disconnect and new pairing ask the worker to log out before credentials are wiped; redeploys never do', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orderly-logout-test-'));
  const log = join(dataDir, 'stops.log');
  process.env.ORDERLY_TEST_STOP_LOG = log;
  const config = {
    secret: 'test-secret-with-at-least-32-characters',
    key: Buffer.alloc(32, 4),
    eventsUrl: 'https://invalid.invalid',
    port: 8080,
    maxSessions: 10,
    dataDir,
    version: undefined,
  };
  const worker = new URL('./fixtures/test-worker.js', import.meta.url);
  const supervisor = new Supervisor(config, worker);
  const [a, b, c] = Array.from({ length: 3 }, () => ({
    connectionId: randomUUID(),
    generation: 1,
  }));
  const eventually = async (check: () => boolean) => {
    const until = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > until) throw new Error('Timed out waiting for test worker');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const stops = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' '));
  try {
    for (const s of [a, b, c]) await supervisor.command({ ...s, action: 'pair', method: 'qr' });
    await eventually(() => [a, b, c].every((s) => supervisor.status(s).status === 'connected'));
    // Saved credentials for a, as a paired worker would have.
    const path = join(dataDir, `${a!.connectionId}.sqlite`);
    const sessionStore = new Store(path, config.key);
    sessionStore.set('auth', 'creds', { me: 'test' });
    sessionStore.close();

    await supervisor.command({ ...a!, generation: 2, action: 'disconnect' });
    await supervisor.command({ ...b!, generation: 2, action: 'pair', method: 'qr' });
    await supervisor.command({ ...c!, action: 'reconnect' });
    assert.deepEqual(stops(), [
      // The worker was told to log out while the credentials were still on disk.
      [a!.connectionId, 'true', '1'],
      [b!.connectionId, 'true', '0'],
      [c!.connectionId, 'false', '0'],
    ]);
    const after = new Store(path, config.key);
    assert.equal(after.count('auth'), 0);
    after.close();

    // Shutting down for a redeploy keeps every pairing.
    await eventually(() => supervisor.status({ ...b!, generation: 2 }).status === 'connected');
    await eventually(() => supervisor.status(c!).status === 'connected');
    await supervisor.close();
    assert.deepEqual(
      stops()
        .slice(3)
        .map(([, logout]) => logout),
      ['false', 'false'],
    );
  } finally {
    delete process.env.ORDERLY_TEST_STOP_LOG;
    await supervisor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
