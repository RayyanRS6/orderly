import { resolve } from 'node:path';

export function loadConfig() {
  const secret = process.env.GATEWAY_SHARED_SECRET ?? '';
  const key = Buffer.from(process.env.GATEWAY_ENCRYPTION_KEY ?? '', 'base64');
  const eventsUrl = new URL(process.env.ORDERLY_EVENTS_URL ?? 'https://invalid.invalid');
  if (
    secret.length < 32 ||
    key.length !== 32 ||
    eventsUrl.protocol !== 'https:' ||
    eventsUrl.hostname === 'invalid.invalid' ||
    eventsUrl.username ||
    eventsUrl.password ||
    eventsUrl.search ||
    eventsUrl.hash
  )
    throw new Error('Configure gateway secret, encryption key and HTTPS events URL.');
  const maxSessions = Number(process.env.GATEWAY_MAX_SESSIONS ?? 10);
  const port = Number(process.env.GATEWAY_PORT ?? 8080);
  if (
    !Number.isInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 10 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Invalid gateway limits.');
  const version = process.env.GATEWAY_WA_VERSION;
  if (version && !/^\d{1,10},\d{1,10},\d{1,10}$/.test(version))
    throw new Error('Invalid approved WA version tuple.');
  return {
    secret,
    key,
    eventsUrl: eventsUrl.href,
    port,
    maxSessions,
    dataDir: resolve(process.env.GATEWAY_DATA_DIR ?? 'data'),
    version: version?.split(',').map(Number) as [number, number, number] | undefined,
  };
}
export type GatewayConfig = ReturnType<typeof loadConfig>;
