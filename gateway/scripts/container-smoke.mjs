// Runs only with an already-built image and Docker. Never pairs/sends or contacts Supabase.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { signedHeaders } from '../dist/server/whatsapp/signing.js';
import { probeGateway } from '../dist/gateway/src/deployment.js';

const name = `orderly-smoke-${randomUUID()}`;
const secret = randomBytes(32).toString('hex');
const env = {
  ...process.env,
  GATEWAY_SHARED_SECRET: secret,
  GATEWAY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ORDERLY_EVENTS_URL: 'https://invalid.example/events',
  GATEWAY_MAX_SESSIONS: '1',
};
function docker(args) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60000 });
  // No raw output on failure: Docker can include environment values in diagnostics.
  if (result.error || result.status !== 0) throw new Error(`Docker ${args[0]} failed.`);
  return result.stdout.trim();
}
async function ready(base) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* bounded local startup polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Container did not become healthy.');
}
let stage = 'start container';
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--init',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--memory=1280m',
    '--pids-limit=150',
    '--tmpfs',
    '/tmp:size=32m,mode=1777',
    // Anonymous volume: survives restart; removed only with this disposable container.
    '-v',
    '/data',
    '-p',
    '127.0.0.1::8080',
    ...[
      'GATEWAY_SHARED_SECRET',
      'GATEWAY_ENCRYPTION_KEY',
      'ORDERLY_EVENTS_URL',
      'GATEWAY_MAX_SESSIONS',
    ].flatMap((key) => ['-e', key]),
    'orderly-gateway:test',
  ]);
  stage = 'read published port';
  // An ephemeral host port can change when the container restarts, so read it each time.
  const published = () => {
    const address = docker(['port', name, '8080/tcp']);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    return `http://${address}`;
  };
  let base = published();
  stage = 'first /healthz';
  await ready(base);
  stage = 'non-root user';
  assert.equal(docker(['exec', name, 'id', '-u']), '1000');
  stage = 'signed health probe';
  assert.deepEqual(await probeGateway(base, secret), { workers: 0, maxSessions: 1 });
  const headers = signedHeaders(secret, 'command', '/health', '{}');
  const post = () =>
    fetch(`${base}/health`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  stage = 'signed POST /health';
  assert.equal((await post()).status, 200);
  stage = 'restart';
  docker(['restart', '--time', '30', name]);
  stage = '/healthz after restart';
  base = published();
  await ready(base);
  stage = 'nonce replay after restart';
  assert.equal((await post()).status, 401, 'nonce must survive a container restart');
  stage = 'signed health probe after restart';
  assert.deepEqual(await probeGateway(base, secret), { workers: 0, maxSessions: 1 });
  console.info(
    'Container smoke passed: non-root read-only runtime, persistent SQLite, restart, HMAC and replay checks. No WhatsApp pairing.',
  );
} catch (error) {
  console.error(
    `Container smoke failed at "${stage}": ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  // The gateway logs only event codes and crash traces, never configuration values, and this
  // run's secrets are random and discarded. Docker's own diagnostics are not printed.
  const logs = spawnSync('docker', ['logs', '--tail', '60', name], {
    encoding: 'utf8',
    timeout: 30000,
  });
  console.error(`Container log (last 60 lines):\n${logs.stdout ?? ''}${logs.stderr ?? ''}`);
  process.exitCode = 1;
} finally {
  // The exact random test name, never a production container or broad volume prune.
  spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30000 });
}
