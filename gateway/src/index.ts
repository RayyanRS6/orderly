import { createServer } from 'node:http';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { GatewayError, Supervisor } from './supervisor.js';
import { verifySigned } from '../../server/whatsapp/signing.js';

const config = loadConfig();
const supervisor = new Supervisor(config);
supervisor.restore();
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const reply = (status: number, body: unknown) => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      reply(200, { ok: true });
      return;
    }
    if (
      request.method !== 'POST' ||
      !['/health', '/session', '/status', '/send'].includes(request.url ?? '')
    )
      throw new GatewayError('NOT_FOUND', 404);
    if (request.headers.origin) throw new GatewayError('BROWSER_ACCESS_FORBIDDEN', 403);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32768) throw new GatewayError('BODY_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers))
      if (typeof value === 'string') headers.set(key, value);
    const nonce = verifySigned(config.secret, 'command', request.url!, raw, headers);
    if (!nonce || !supervisor.store.nonce(nonce))
      throw new GatewayError('INVALID_SIGNATURE_OR_REPLAY', 401);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new GatewayError('INVALID_JSON', 400);
    }
    const result =
      request.url === '/health'
        ? supervisor.health()
        : request.url === '/session'
          ? await supervisor.command(body)
          : request.url === '/status'
            ? supervisor.status(body)
            : await supervisor.send(body);
    reply(200, result);
  } catch (error) {
    reply(error instanceof GatewayError ? error.status : error instanceof ZodError ? 400 : 500, {
      errorCode:
        error instanceof GatewayError
          ? error.code
          : error instanceof ZodError
            ? 'INVALID_INPUT'
            : 'GATEWAY_FAILURE',
    });
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.maxConnections = 64;
server.listen(config.port, '0.0.0.0');
async function shutdown() {
  server.close();
  await supervisor.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('uncaughtException', () => {
  console.error('SUPERVISOR_FATAL');
  process.exit(1);
});
process.on('unhandledRejection', () => {
  console.error('SUPERVISOR_REJECTION');
  process.exit(1);
});
