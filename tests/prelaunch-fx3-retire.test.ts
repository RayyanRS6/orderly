// Linked-phone gateway fix (fx-3): a session Orderly no longer uses (the business switched to
// Meta or disconnected while the gateway could not be told) is answered 410, so the gateway ends it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { createApp } from '../server/app';
import { signedHeaders } from '../server/whatsapp/signing';
import {
  disconnectGateway,
  receiveGatewayEvent,
  saveConnection,
  selectMeta,
} from '../server/whatsapp/connections';
import { gatewayEventSchema, type WhatsAppConnection } from '../src/shared/whatsapp';
import { seedCompanies } from '../src/shared/seed';

const company = seedCompanies[0];
const secret = 'gateway-test-secret-with-more-than-32-characters';
let repo: MemoryRepository;
let connection: WhatsAppConnection;
beforeEach(async () => {
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
  vi.stubEnv('WHATSAPP_GATEWAY_SECRET', secret);
  repo = new MemoryRepository();
  connection = {
    id: randomUUID(),
    companyId: company.id,
    provider: 'baileys',
    generation: 1,
    revision: 1,
    status: 'connected',
    accountJid: '923000000001@s.whatsapp.net',
    lastHeartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await repo.saveWhatsAppConnection(connection, 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function event(overrides: Record<string, unknown> = {}) {
  return gatewayEventSchema.parse({
    eventId: randomUUID(),
    connectionId: connection.id,
    generation: 1,
    type: 'message',
    peer: '100000001@lid',
    messageId: 'wamid-one',
    text: 'menu',
    fromMe: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  });
}
const heartbeat = () =>
  event({
    type: 'status',
    status: 'connected',
    accountJid: connection.accountJid,
    peer: undefined,
    messageId: undefined,
    text: undefined,
    fromMe: undefined,
  });
// The signed callback the gateway posts.
async function post(value: ReturnType<typeof event>) {
  const raw = JSON.stringify(value);
  return createApp(repo).request('http://127.0.0.1/api/whatsapp/gateway/events', {
    method: 'POST',
    headers: signedHeaders(secret, 'event', '/api/whatsapp/gateway/events', raw),
    body: raw,
  });
}
const current = async () => (await repo.getWhatsAppConnection(company.id))!;

describe('a linked-phone session left running after the business moved on', () => {
  it('is answered 410 after switching to Meta while the gateway was unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await selectMeta(repo, company.id))?.gatewayCleanupPending).toBe(true);
    vi.unstubAllGlobals();
    const before = await current();
    for (const value of [heartbeat(), event()]) {
      const response = await post(value);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: 'Orderly no longer uses this linked-phone session.',
      });
    }
    // Nothing is saved or answered for it.
    expect(await current()).toEqual(before);
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
  });

  it('is answered 410 after a disconnect the gateway did not hear about', async () => {
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'false');
    expect((await disconnectGateway(repo, company.id)).gatewayCleanupPending).toBe(true);
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
    await expect(receiveGatewayEvent(repo, heartbeat())).rejects.toMatchObject({ status: 410 });
    await expect(
      receiveGatewayEvent(repo, event({ type: 'receipt', receipt: 'read', text: undefined })),
    ).rejects.toMatchObject({ status: 410 });
    expect((await current()).status).toBe('disconnected');
  });

  it('is left alone while a newer linked-phone pairing may still be starting', async () => {
    for (const [status, errorCode] of [
      ['connecting', undefined],
      ['awaiting_pairing', undefined],
      ['connected', undefined],
      ['error', 'GATEWAY_START_FAILED'],
    ] as const) {
      const latest = await current();
      await saveConnection(repo, {
        ...latest,
        provider: 'baileys',
        generation: latest.generation + 1,
        status,
        errorCode,
      });
      // The old generation's events are dropped quietly: the gateway replaces that session itself.
      expect((await post(heartbeat())).status, status).toBe(200);
      expect((await post(event({ messageId: `old-${status}` }))).status, status).toBe(200);
    }
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
  });

  it('is never retired for an unknown connection, a newer generation or the current one', async () => {
    expect((await post(event({ connectionId: randomUUID() }))).status).toBe(200);
    await saveConnection(repo, { ...(await current()), provider: 'meta', status: 'connected' });
    // A generation Orderly has not reached (a database restored from backup): not proof enough.
    expect((await post(event({ generation: 2 }))).status).toBe(200);
    // The current generation on Meta is not a linked-phone session to end either.
    expect((await post(event({ messageId: 'same-generation' }))).status).toBe(200);
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
  });
});
