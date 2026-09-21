import { resolve } from 'node:path';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.GATEWAY_SHARED_SECRET ?? '';
  const encodedKey = env.GATEWAY_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(encodedKey, 'base64');
  let eventsUrl: URL;
  try {
    eventsUrl = new URL(env.ORDERLY_EVENTS_URL ?? 'https://invalid.invalid');
  } catch {
    throw new Error('Configure a valid HTTPS events URL.');
  }
  if (
    secret.length < 32 ||
    secret.startsWith('replace-with-') ||
    key.length !== 32 ||
    key.toString('base64') !== encodedKey ||
    eventsUrl.protocol !== 'https:' ||
    eventsUrl.hostname === 'invalid.invalid' ||
    eventsUrl.username ||
    eventsUrl.password ||
    eventsUrl.search ||
    eventsUrl.hash
  )
    throw new Error('Configure gateway secret, encryption key and HTTPS events URL.');
  const maxSessions = Number(env.GATEWAY_MAX_SESSIONS ?? 10);
  const port = Number(env.GATEWAY_PORT ?? 8080);
  if (
    !Number.isInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 10 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Invalid gateway limits.');
  const version = env.GATEWAY_WA_VERSION;
  if (version && !/^\d{1,10},\d{1,10},\d{1,10}$/.test(version))
    throw new Error('Invalid approved WA version tuple.');
  return {
    secret,
    key,
    eventsUrl: eventsUrl.href,
    port,
    maxSessions,
    dataDir: resolve(env.GATEWAY_DATA_DIR ?? 'data'),
    version: version?.split(',').map(Number) as [number, number, number] | undefined,
  };
}
export type GatewayConfig = ReturnType<typeof loadConfig>;
