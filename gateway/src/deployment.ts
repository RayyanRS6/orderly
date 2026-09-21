import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';
import { loadConfig } from './config.js';
import { signedHeaders } from '../../server/whatsapp/signing.js';

export function deploymentSettings(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env);
  const hostname = env.GATEWAY_HOSTNAME ?? '';
  const email = env.ACME_EMAIL ?? '';
  // These strings enter a Caddyfile and a dotenv file: no interpolation or newlines.
  if (
    hostname.length > 253 ||
    isIP(hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) ||
    /\.(?:example|invalid|test|localhost)$/.test(hostname)
  )
    throw new Error('GATEWAY_HOSTNAME must be a public DNS hostname, without a scheme or path.');
  if (!/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(email))
    throw new Error('ACME_EMAIL must be a valid certificate contact email.');
  if (new URL(config.eventsUrl).pathname !== '/functions/v1/orderly/api/whatsapp/gateway/events')
    throw new Error(
      'ORDERLY_EVENTS_URL must point to the deployed Orderly gateway events endpoint.',
    );
  if (config.port !== 8080) throw new Error('The supplied deployment expects GATEWAY_PORT=8080.');
  return { config, hostname, email };
}

export function createDeploymentFile(
  path: string,
  hostname: string,
  email: string,
  eventsUrl: string,
) {
  const env = {
    GATEWAY_HOSTNAME: hostname,
    ACME_EMAIL: email,
    GATEWAY_SHARED_SECRET: randomBytes(32).toString('hex'),
    GATEWAY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ORDERLY_EVENTS_URL: eventsUrl,
    // One real restaurant first. Raise only after measured live acceptance.
    GATEWAY_MAX_SESSIONS: '1',
    GATEWAY_PORT: '8080',
  };
  deploymentSettings(env);
  // Quotes, $, newlines or comments could alter dotenv/Compose interpretation.
  if (Object.values(env).some((value) => /[\s'"$#\\]/.test(value)))
    throw new Error('Deployment values must not contain dotenv interpolation or whitespace.');
  writeFileSync(
    path,
    '# Private gateway configuration. Never commit or share.\n' +
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
}

export function readDeploymentFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile())
    throw new Error('Deployment configuration must be a regular file, not a symlink.');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    throw new Error('Deployment configuration must be private: chmod 600 gateway/.env.');
  const env = parseEnv(readFileSync(path, 'utf8'));
  return deploymentSettings(env);
}

// Health probes cannot pair a number, send a message, or mutate restaurant state.
export async function probeGateway(origin: string, secret: string, request: typeof fetch = fetch) {
  const raw = '{}';
  const headers = signedHeaders(secret, 'command', '/health', raw);
  const send = (signed: boolean) =>
    request(`${origin}/health`, {
      method: 'POST',
      body: raw,
      headers: signed ? headers : { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  if ((await send(false)).status !== 401)
    throw new Error('Unsigned gateway access was not rejected.');
  const response = await send(true);
  if (!response.ok)
    throw new Error('Signed gateway health check failed; verify the shared secret.');
  const health = (await response.json()) as Record<string, unknown>;
  if (health.ok !== true || !Number.isInteger(health.workers) || !Number.isInteger(health.capacity))
    throw new Error('Gateway returned an unexpected health response.');
  if ((await send(true)).status !== 401)
    throw new Error('Gateway did not reject a replayed signature.');
  return { workers: health.workers, maxSessions: health.capacity };
}
