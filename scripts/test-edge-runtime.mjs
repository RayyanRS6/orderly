import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';

// Use a spare port, fictional credentials and no access to real databases.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const child = spawn(
  resolve('node_modules/deno', process.platform === 'win32' ? 'deno.exe' : 'deno'),
  [
    'run',
    '--no-config',
    '--allow-env',
    '--allow-sys=hostname',
    `--allow-net=127.0.0.1:${port}`,
    'scripts/edge-smoke-entry.ts',
  ],
  {
    env: {
      ...process.env,
      APP_MODE: 'live',
      APP_URL: 'https://orderly.example.workers.dev',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'fictional-service-key',
      SUPABASE_ANON_KEY: 'fictional-public-key',
      CRON_SECRET: 'fictional-worker-secret',
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      ORDERLY_TEST_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
try {
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/orderly/api/health`);
      if (res.ok && (await res.json()).mode === 'live') {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Deno startup failed: ${output.slice(-3000)}`);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/orderly/api/account`);
  if (unauthorized.status !== 401) throw new Error('Deno API did not enforce user authentication.');
  console.log(
    'Deno runtime smoke passed: real bundle started, health responded, private API rejected anonymous access.',
  );
} finally {
  child.kill();
}
