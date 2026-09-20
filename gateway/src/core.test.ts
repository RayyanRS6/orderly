import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { canonicalJid, phoneFromJid, disconnectPolicy, retryDelay } from './policy.js';
import { sendOnce, recoverUncertainSends, type Receipt } from './sender.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-gateway-test-'));
  const path = join(dir, 'session.sqlite');
  const key = Buffer.alloc(32, 9);
  const store = new Store(path, key);
  return {
    store,
    path,
    key,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('encrypted SQLite never stores plaintext credentials and rejects swapped rows', () => {
  const f = fixture();
  try {
    f.store.set('auth', 'a', { token: 'private-auth-test-value' });
    f.store.set('auth', 'b', { token: 'other' });
    assert.deepEqual(f.store.get('auth', 'a'), { token: 'private-auth-test-value' });
    assert.equal(readFileSync(f.path).includes('private-auth-test-value'), false);
    const db = new DatabaseSync(f.path);
    db.exec("UPDATE records SET value=(SELECT value FROM records WHERE id='a') WHERE id='b'");
    db.close();
    assert.throws(() => f.store.get('auth', 'b'));
  } finally {
    f.close();
  }
});
test('transactions roll back incomplete auth updates and nonces are single-use', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.store.transaction(() => {
        f.store.set('auth', 'a', 'one');
        throw new Error('fail');
      }),
    );
    assert.equal(f.store.get('auth', 'a'), undefined);
    assert.equal(f.store.nonce('one'), true);
    assert.equal(f.store.nonce('one'), false);
    assert.equal(f.store.lease('first'), true);
    assert.equal(f.store.lease('second'), false);
    f.store.releaseLease('first');
    assert.equal(f.store.lease('second'), true);
  } finally {
    f.close();
  }
});
test('unknown LIDs are never interpreted as telephone numbers and group addresses are rejected', () => {
  assert.equal(phoneFromJid('1234567890@lid'), undefined);
  assert.equal(phoneFromJid('923000000000:5@s.whatsapp.net'), '+923000000000');
  assert.equal(canonicalJid('923000000000:5@s.whatsapp.net'), '923000000000@s.whatsapp.net');
  for (const jid of ['1234567890@g.us', 'status@broadcast', '1234567890@newsletter', '../../other'])
    assert.equal(canonicalJid(jid), undefined);
});
test('disconnect policies distinguish terminal failures from restart and network errors', () => {
  assert.equal(disconnectPolicy(401), 'logout');
  assert.equal(disconnectPolicy(515), 'restart');
  for (const code of [408, 428, 503]) assert.equal(disconnectPolicy(code), 'retry');
  for (const code of [403, 411, 440, 500, 405, 0]) assert.equal(disconnectPolicy(code), 'stop');
  assert.ok(retryDelay(3, 0) < retryDelay(3, 1));
  assert.ok(retryDelay(100, 1) <= 75000);
});
const body = {
  idempotencyKey: 'job-one',
  peer: '923000000000@s.whatsapp.net',
  text: 'hello',
  generation: 1,
};
test('duplicate sends return the saved receipt without sending twice, even after reopening storage', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const deliver = async () => {
      calls++;
      assert.ok(f.store.get('own', 'message-one'));
      return 'message-one';
    };
    assert.deepEqual(await sendOnce(f.store, body, 'message-one', deliver), {
      messageId: 'message-one',
    });
    assert.deepEqual(await sendOnce(f.store, body, 'different-id', deliver), {
      messageId: 'message-one',
    });
    assert.equal(calls, 1);
    const reopened = new Store(f.path, f.key);
    assert.deepEqual(await sendOnce(reopened, body, 'another-id', deliver), {
      messageId: 'message-one',
    });
    reopened.close();
    assert.equal(calls, 1);
    await assert.rejects(
      sendOnce(f.store, { ...body, text: 'changed' }, 'x', deliver),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    f.close();
  }
});
test('ambiguous delivery is not retried automatically after timeout or process interruption', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const deliver = async () => {
      calls++;
      throw new Error('socket timeout after sending');
    };
    await assert.rejects(sendOnce(f.store, body, 'message-one', deliver), /SEND_UNCERTAIN/);
    await assert.rejects(sendOnce(f.store, body, 'message-two', deliver), /SEND_UNCERTAIN/);
    assert.equal(calls, 1);
    const receipt = f.store.get<Receipt>('receipts', body.idempotencyKey)!;
    f.store.set('receipts', body.idempotencyKey, { ...receipt, state: 'sending' });
    recoverUncertainSends(f.store);
    assert.equal(f.store.get<Receipt>('receipts', body.idempotencyKey)?.state, 'uncertain');
  } finally {
    f.close();
  }
});
