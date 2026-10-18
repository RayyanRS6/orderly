import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crashRestartDelay,
  heartbeatDue,
  reconnectDecision,
  restorable,
  TICK_MS,
} from './policy.js';
import { GATEWAY_HEARTBEAT_MS, GATEWAY_HEARTBEAT_STALE_MS } from '../../src/shared/whatsapp.js';

// F04: a network blip, a WhatsApp 503 storm or one 'Stream Errored (unknown)' must never
// leave a restaurant's linked phone parked until someone clicks Reconnect.
test('network failures retry forever, backing off to a minute and then five minutes', () => {
  for (const code of [408, 428, 503]) {
    const delays = Array.from({ length: 20 }, (_, i) => {
      const decision = reconnectDecision(code, i + 1, 0, 0.5);
      assert.equal(decision.action, 'retry');
      return decision.delayMs;
    });
    assert.equal(delays[0], 1000);
    assert.ok(delays.slice(0, 10).every((delay) => delay <= 60000));
    assert.ok(delays.slice(10).every((delay) => delay === 300000));
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i]! >= delays[i - 1]!);
  }
});

test("Baileys' generic 500, code 0 and unknown codes retry with a slower start and the 5-minute cap", () => {
  for (const code of [500, 0, 499, 1006]) {
    const delays = Array.from({ length: 20 }, (_, i) => {
      const decision = reconnectDecision(code, i + 1, 0, 0.5);
      assert.equal(decision.action, 'retry');
      return decision.delayMs;
    });
    assert.equal(delays[0], 5000);
    assert.ok(delays.every((delay) => delay <= 300000));
    assert.equal(delays[19], 300000);
  }
  // Jitter stays within a quarter either side, also at the cap.
  assert.ok(reconnectDecision(500, 50, 0, 1).delayMs <= 375000);
  assert.ok(reconnectDecision(500, 50, 0, 0).delayMs >= 225000);
});

test('logout, account refusals and an outdated web version never reconnect by themselves', () => {
  assert.deepEqual(reconnectDecision(401, 1), { action: 'logout', delayMs: 0 });
  for (const code of [403, 405, 411, 440])
    assert.deepEqual(reconnectDecision(code, 7), { action: 'stop', delayMs: 0 });
});

test('a requested restart (515) reconnects at once, but a restart loop backs off', () => {
  for (const restarts of [0, 1, 2])
    assert.deepEqual(reconnectDecision(515, 1, restarts), { action: 'restart', delayMs: 0 });
  const looping = reconnectDecision(515, 1, 3, 0.5);
  assert.equal(looping.action, 'retry');
  assert.equal(looping.delayMs, 5000);
});

test('crashed workers keep restarting after five crashes, at most every 30 minutes', () => {
  const delays = Array.from({ length: 30 }, (_, i) => crashRestartDelay(i + 1, 0.5));
  assert.equal(delays[0], 1000);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i]! >= delays[i - 1]!);
  assert.ok(delays.every((delay) => Number.isFinite(delay) && delay <= 1800000));
  assert.equal(delays[29], 1800000);
  assert.ok(crashRestartDelay(100, 1) <= 2250000);
});

test('a gateway restart revives sessions parked by passing failures, never refused ones', () => {
  for (const status of ['connected', 'connecting', 'reconnecting']) assert.ok(restorable(status));
  for (const code of [
    'RECONNECT_EXHAUSTED',
    'SESSION_CRASH',
    'INBOUND_QUEUE_FULL',
    'UNCAUGHT_EXCEPTION',
    'DISCONNECT_0',
    'DISCONNECT_408',
    'DISCONNECT_428',
    'DISCONNECT_500',
    'DISCONNECT_503',
    'DISCONNECT_515',
  ])
    assert.equal(restorable('error', code), true, code);
  for (const code of [
    'DISCONNECT_401',
    'DISCONNECT_403',
    'DISCONNECT_405',
    'DISCONNECT_411',
    'DISCONNECT_440',
    'INVALID_ACCOUNT_IDENTITY',
    'PAIRING_EXPIRED',
    undefined,
  ])
    assert.equal(restorable('error', code), false, String(code));
  for (const status of ['disconnected', 'logged_out', 'awaiting_pairing'])
    assert.equal(restorable(status, 'SESSION_CRASH'), false);
});

// F06: one Supabase function call per minute per number instead of every 15 seconds.
test('the 15-second tick re-sends an unchanged connected status once a minute', () => {
  assert.ok(GATEWAY_HEARTBEAT_MS >= 45000);
  assert.ok(GATEWAY_HEARTBEAT_STALE_MS >= 3 * GATEWAY_HEARTBEAT_MS);
  let lastStatusAt = 0;
  let beats = 0;
  // One hour of ticks, each arriving a little late as real timers do.
  for (let tick = 1; tick <= 240; tick++) {
    const now = tick * TICK_MS + (tick % 7) * 40;
    if (heartbeatDue(lastStatusAt, now, GATEWAY_HEARTBEAT_MS)) {
      assert.ok(now - lastStatusAt <= GATEWAY_HEARTBEAT_MS + TICK_MS);
      lastStatusAt = now;
      beats++;
    }
  }
  assert.equal(beats, 60);
  // A real status change resets the clock: the next keepalive waits a full interval.
  assert.equal(heartbeatDue(100000, 100000 + 45000, GATEWAY_HEARTBEAT_MS), false);
  assert.equal(heartbeatDue(100000, 100000 + 59900, GATEWAY_HEARTBEAT_MS), true);
});
