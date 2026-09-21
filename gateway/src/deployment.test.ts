import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadConfig } from './config.js';
import {
  createDeploymentFile,
  readDeploymentFile,
  deploymentSettings,
  probeGateway,
} from './deployment.js';
import { verifySigned } from '../../server/whatsapp/signing.js';

const hostname = 'gateway.restaurant.com';
const email = 'ops@restaurant.com';
const events = 'https://project.supabase.co/functions/v1/orderly/api/whatsapp/gateway/events';
const base = {
  GATEWAY_SHARED_SECRET: 'deployment-test-secret-32-characters-long',
  GATEWAY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ORDERLY_EVENTS_URL: events,
  GATEWAY_HOSTNAME: hostname,
  ACME_EMAIL: email,
};

test('deployment generator creates private independent keys, defaults to one number and never replaces credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-deployment-'));
  try {
    const path = join(dir, '.env');
    createDeploymentFile(path, hostname, email, events);
    const original = readFileSync(path, 'utf8');
    const env = parseEnv(original);
    assert.ok(env.GATEWAY_SHARED_SECRET);
    const settings = readDeploymentFile(path);
    assert.equal(settings.config.maxSessions, 1);
    assert.equal(settings.hostname, hostname);
    assert.equal(settings.config.key.length, 32);
    assert.equal(env.GATEWAY_SHARED_SECRET.length, 64);
    assert.notEqual(settings.config.secret, settings.config.key.toString('hex'));
    assert.throws(() => createDeploymentFile(path, hostname, email, events), { code: 'EEXIST' });
    assert.equal(readFileSync(path, 'utf8'), original);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      chmodSync(path, 0o644);
      assert.throws(() => readDeploymentFile(path), /private/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment validation rejects placeholders, malformed base64, wrong endpoints and config injection', () => {
  assert.doesNotThrow(() => deploymentSettings(base));
  for (const value of [
    'https://gateway.restaurant.com',
    'localhost',
    '127.0.0.1',
    'foo.example',
    'gateway.com\nadmin off',
    '${HOST}',
  ])
    assert.throws(() => deploymentSettings({ ...base, GATEWAY_HOSTNAME: value }));
  for (const value of ['someone\nX=1', '"a"@example.com', 'ops@domain.com {$SECRET}'])
    assert.throws(() => deploymentSettings({ ...base, ACME_EMAIL: value }));
  for (const value of [
    'not a URL',
    'http://project.supabase.co/events',
    'https://project.supabase.co/wrong',
    `${events}?secret=abc`,
  ])
    assert.throws(() => deploymentSettings({ ...base, ORDERLY_EVENTS_URL: value }));
  assert.throws(() =>
    loadConfig({ ...base, GATEWAY_ENCRYPTION_KEY: base.GATEWAY_ENCRYPTION_KEY + '!' }),
  );
  assert.throws(() =>
    loadConfig({ ...base, GATEWAY_SHARED_SECRET: 'replace-with-at-least-32-random-characters' }),
  );
  assert.throws(() => deploymentSettings({ ...base, GATEWAY_PORT: '9000' }));
  assert.throws(() => loadConfig({ ...base, GATEWAY_MAX_SESSIONS: '11' }));
});

test('configure and doctor CLIs operate offline without printing credentials or overwriting the env file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-cli-'));
  try {
    const configure = fileURLToPath(new URL('./configure.js', import.meta.url));
    const args = [configure, '--hostname', hostname, '--email', email, '--events-url', events];
    const created = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const original = readFileSync(join(dir, '.env'), 'utf8');
    const env = parseEnv(original);
    assert.ok(env.GATEWAY_SHARED_SECRET);
    assert.ok(env.GATEWAY_ENCRYPTION_KEY);
    const second = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /refusing to overwrite/);
    const doctor = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./doctor.js', import.meta.url))],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Offline check only/);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), original);
    const output =
      created.stdout +
      created.stderr +
      second.stdout +
      second.stderr +
      doctor.stdout +
      doctor.stderr;
    assert.equal(output.includes(env.GATEWAY_SHARED_SECRET), false);
    assert.equal(output.includes(env.GATEWAY_ENCRYPTION_KEY), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('online doctor checks only health, refuses unsigned access and verifies durable replay handling', async () => {
  const seen = new Set<string>();
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'error');
    const nonce = verifySigned(
      base.GATEWAY_SHARED_SECRET,
      'command',
      '/health',
      String(init?.body),
      new Headers(init?.headers),
    );
    if (!nonce || seen.has(nonce)) return new Response('{}', { status: 401 });
    seen.add(nonce);
    return Response.json({ ok: true, workers: 0, capacity: 1 });
  };
  assert.deepEqual(await probeGateway(`https://${hostname}`, base.GATEWAY_SHARED_SECRET, request), {
    workers: 0,
    maxSessions: 1,
  });
  assert.deepEqual(calls, Array(3).fill(`https://${hostname}/health`));
  await assert.rejects(
    probeGateway(`https://${hostname}`, base.GATEWAY_SHARED_SECRET, async () =>
      Response.json({ ok: true }),
    ),
    /Unsigned/,
  );
});
