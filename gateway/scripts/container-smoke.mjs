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
  const address = docker(['port', name, '8080/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = `http://${address}`;
  await ready(base);
  assert.equal(docker(['exec', name, 'id', '-u']), '1000');
  assert.deepEqual(await probeGateway(base, secret), { workers: 0, maxSessions: 1 });
  const headers = signedHeaders(secret, 'command', '/health', '{}');
  const post = () =>
    fetch(`${base}/health`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  assert.equal((await post()).status, 200);
  docker(['restart', '--time', '30', name]);
  await ready(base);
  assert.equal((await post()).status, 401, 'nonce must survive a container restart');
  assert.deepEqual(await probeGateway(base, secret), { workers: 0, maxSessions: 1 });
  console.info(
    'Container smoke passed: non-root read-only runtime, persistent SQLite, restart, HMAC and replay checks. No WhatsApp pairing.',
  );
} catch {
  console.error(
    'Container smoke failed. Investigate locally without publishing environment values or auth data.',
  );
  process.exitCode = 1;
} finally {
  // The exact random test name, never a production container or broad volume prune.
  spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30000 });
}
