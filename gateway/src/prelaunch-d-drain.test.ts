import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { drainOnce, retryDeadEvents, safeMessageId, type DeadEvent } from './drain.js';
import { gatewayEventSchema, type GatewayEvent } from '../../src/shared/whatsapp.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-drain-test-'));
  const store = new Store(join(dir, 'session.sqlite'), Buffer.alloc(32, 5));
  return {
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const connectionId = randomUUID();
function message(messageId: string, at = new Date()): GatewayEvent {
  return {
    eventId: randomUUID(),
    connectionId,
    generation: 1,
    type: 'message',
    peer: '100000001@lid',
    messageId,
    text: 'menu',
    fromMe: false,
    unsupported: false,
    timestamp: at.toISOString(),
  };
}
function enqueue(store: Store, event: GatewayEvent) {
  store.set('events', event.eventId, event);
  return event;
}
// Answers each posted event by its messageId, and records what was posted.
function backend(statuses: Record<string, number | 'offline'>) {
  const posted: string[] = [];
  const post = async (raw: string) => {
    const event = JSON.parse(raw) as GatewayEvent;
    const key = event.messageId ?? event.type;
    posted.push(key);
    const status = statuses[key] ?? 200;
    if (status === 'offline') throw new Error('offline');
    return status;
  };
  return { post, posted };
}

// F24: one message Orderly can never accept must not stop every later customer message.
test('a permanently rejected message is set aside and the next customer message is delivered', async () => {
  const f = fixture();
  try {
    const bad = enqueue(f.store, message('bad'));
    enqueue(f.store, message('good'));
    const { post, posted } = backend({ bad: 400 });
    assert.equal(await drainOnce(f.store, post), 2);
    assert.deepEqual(posted, ['bad', 'good']);
    assert.equal(f.store.count('events'), 0);
    assert.equal(f.store.count('dead-events'), 1);
    const dead = f.store.get<DeadEvent>('dead-events', bad.eventId)!;
    assert.equal(dead.reason, 'HTTP_400');
    assert.equal(dead.event.messageId, 'bad');
    // 413 and 422 are permanent too.
    enqueue(f.store, message('large'));
    enqueue(f.store, message('invalid'));
    assert.equal(await drainOnce(f.store, backend({ large: 413, invalid: 422 }).post), 2);
    assert.equal(f.store.count('dead-events'), 3);
  } finally {
    f.close();
  }
});

test('passing failures keep messages queued in order and are retried, never dropped', async () => {
  for (const status of [500, 503, 401, 409, 429, 404, 'offline'] as const) {
    const f = fixture();
    try {
      enqueue(f.store, message('first'));
      enqueue(f.store, message('second'));
      const { post, posted } = backend({ first: status });
      assert.equal(await drainOnce(f.store, post), false, String(status));
      assert.deepEqual(posted, ['first']);
      assert.equal(f.store.count('events'), 2);
      assert.equal(f.store.count('dead-events'), 0);
      // Once Orderly is back the same messages are delivered.
      assert.equal(await drainOnce(f.store, backend({}).post), 2);
      assert.equal(f.store.count('events'), 0);
    } finally {
      f.close();
    }
  }
});

test('a rejected status still holds back messages, and rejected receipts are only dropped', async () => {
  const f = fixture();
  try {
    f.store.set('status-event', 'latest', {
      ...message('status'),
      type: 'status',
      status: 'connected',
    });
    enqueue(f.store, message('waiting'));
    assert.equal(await drainOnce(f.store, backend({ status: 400 }).post), false);
    assert.equal(f.store.count('events'), 1);
    assert.equal(f.store.count('dead-events'), 0);
    f.store.clear('status-event');
    f.store.set('receipt-events', 'r:read', { ...message('tick'), type: 'receipt' });
    assert.equal(await drainOnce(f.store, backend({ tick: 400 }).post), 1);
    assert.equal(f.store.count('receipt-events'), 0);
    assert.equal(f.store.count('dead-events'), 0);
  } finally {
    f.close();
  }
});

test('set-aside messages are bounded, offered again hourly and deleted after the reply window', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 505; i++) enqueue(f.store, message(`m${i}`));
    const rejectAll = async () => 400;
    while ((await drainOnce(f.store, rejectAll)) !== 0);
    assert.equal(f.store.count('dead-events'), 500);
    assert.equal(f.store.count('events'), 0);
    f.store.clear('dead-events');

    const now = Date.now();
    const old = message('old', new Date(now - 25 * 3600000));
    const fresh = message('fresh', new Date(now - 60000));
    for (const event of [old, fresh])
      f.store.set('dead-events', event.eventId, {
        event,
        reason: 'HTTP_400',
        at: now,
        triedAt: now,
      } satisfies DeadEvent);
    const { post, posted } = backend({});
    await retryDeadEvents(f.store, post, now + 60000);
    assert.deepEqual(posted, []);
    assert.equal(f.store.get('dead-events', old.eventId), undefined);
    // An hour later the backend accepts it (for example after its deploy caught up).
    await retryDeadEvents(f.store, post, now + 3600000);
    assert.deepEqual(posted, ['fresh']);
    assert.equal(f.store.count('dead-events'), 0);
    // Still rejected: kept, and tried again only after another hour.
    f.store.set('dead-events', fresh.eventId, {
      event: fresh,
      reason: 'HTTP_400',
      at: now,
      triedAt: now,
    } satisfies DeadEvent);
    const rejecting = backend({ fresh: 400 });
    await retryDeadEvents(f.store, rejecting.post, now + 3600000);
    await retryDeadEvents(f.store, rejecting.post, now + 3700000);
    assert.deepEqual(rejecting.posted, ['fresh']);
    assert.equal(f.store.count('dead-events'), 1);
  } finally {
    f.close();
  }
});

test('an over-long WhatsApp message ID becomes a stable hash Orderly accepts', () => {
  const long = 'A'.repeat(200);
  const safe = safeMessageId(long);
  assert.ok(safe.length <= 150);
  assert.equal(safe, safeMessageId(long));
  assert.notEqual(safe, safeMessageId(`${long}B`));
  assert.equal(safeMessageId('3EB0C431F6A2B1D0E9'), '3EB0C431F6A2B1D0E9');
  assert.equal(safeMessageId('x'.repeat(150)), 'x'.repeat(150));
  assert.ok(gatewayEventSchema.safeParse(message(safe)).success);
  assert.equal(gatewayEventSchema.safeParse(message(long)).success, false);
});
