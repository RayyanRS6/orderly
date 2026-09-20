import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { createApp } from '../server/app';
import { signedHeaders, verifySigned } from '../server/whatsapp/signing';
import {
  assertCurrentAddress,
  receiveGatewayEvent,
  startPairing,
  selectMeta,
  jobAddress,
  saveConnection,
  disconnectGateway,
  metaConfigurationBoundary,
} from '../server/whatsapp/connections';
import {
  gatewayEventSchema,
  type WhatsAppConnection,
  type WhatsAppAddress,
} from '../src/shared/whatsapp';
import { createConversation } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import { processJob } from '../server/service';
import { seedCompanies } from '../src/shared/seed';
import { LinkedWhatsAppAdapter } from '../server/integrations/linked-whatsapp';
import { readiness } from '../server/readiness';

let repo: MemoryRepository;
const company = seedCompanies[0];
const secret = 'gateway-test-secret-with-more-than-32-characters';
let connection: WhatsAppConnection;
let address: WhatsAppAddress;
beforeEach(async () => {
  vi.stubEnv('APP_MODE', 'demo');
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
  address = {
    connectionId: connection.id,
    generation: 1,
    provider: 'baileys',
    peer: '100000001@lid',
  };
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
    peer: address.peer,
    messageId: 'wamid-one',
    text: 'menu',
    fromMe: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  });
}

describe('gateway authentication and ownership', () => {
  it('accepts a signed status callback without a user session and rejects its replay', async () => {
    vi.stubEnv('APP_MODE', 'live');
    const raw = JSON.stringify(
      event({ type: 'status', status: 'connected', accountJid: connection.accountJid }),
    );
    const headers = signedHeaders(secret, 'event', '/api/whatsapp/gateway/events', raw);
    const app = createApp(repo);
    const send = () =>
      app.request('http://127.0.0.1/api/whatsapp/gateway/events', {
        method: 'POST',
        headers,
        body: raw,
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
    expect((await repo.getWhatsAppConnection(company.id))?.revision).toBe(2);
  });
  it('binds signatures to direction, path and body and rejects replay across minute boundaries', async () => {
    const raw = JSON.stringify(event());
    const headers = new Headers(
      signedHeaders(secret, 'event', '/api/whatsapp/gateway/events', raw),
    );
    const nonce = verifySigned(secret, 'event', '/api/whatsapp/gateway/events', raw, headers)!;
    expect(nonce).toBeTruthy();
    expect(
      verifySigned(secret, 'command', '/api/whatsapp/gateway/events', raw, headers),
    ).toBeUndefined();
    expect(verifySigned(secret, 'event', '/send', raw, headers)).toBeUndefined();
    expect(
      verifySigned(secret, 'event', '/api/whatsapp/gateway/events', raw + ' ', headers),
    ).toBeUndefined();
    expect(await repo.consumeGatewayNonce(nonce)).toBe(true);
    expect(await repo.consumeGatewayNonce(nonce)).toBe(false);
  });
  it('rejects a forged tenant field rather than trusting it', () => {
    expect(() =>
      gatewayEventSchema.parse({ ...event(), companyId: seedCompanies[1].id }),
    ).toThrow();
  });
  it('deduplicates messages before model interpretation and derives company from connection', async () => {
    await receiveGatewayEvent(repo, event());
    await receiveGatewayEvent(repo, event());
    const jobs = await repo.listCompanyJobs(company.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.phone).toBe('');
    expect(jobs[0].payload.whatsappAddress).toEqual(address);
    expect(await repo.listCompanyJobs(seedCompanies[1].id)).toHaveLength(0);
  });
  it('rejects unsigned callbacks and refuses sandbox pairing', async () => {
    const app = createApp(repo);
    const pair = await app.request('http://127.0.0.1/api/whatsapp/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-company-id': company.id },
      body: JSON.stringify({ method: 'qr', riskAccepted: true, switchConfirmed: true }),
    });
    expect(pair.status).toBe(503);
    vi.stubEnv('APP_MODE', 'live');
    const response = await app.request('http://127.0.0.1/api/whatsapp/gateway/events', {
      method: 'POST',
      body: JSON.stringify(event()),
    });
    expect(response.status).toBe(401);
  });
  it('rejects stale events after changing generations', async () => {
    await saveConnection(repo, { ...connection, generation: 2 });
    await receiveGatewayEvent(repo, event());
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
    await expect(assertCurrentAddress(repo, company.id, address)).rejects.toMatchObject({
      status: 422,
    });
  });
  it('prevents a connected WhatsApp account being assigned to two restaurants', async () => {
    await expect(
      repo.saveWhatsAppConnection(
        { ...connection, id: randomUUID(), companyId: seedCompanies[1].id },
        0,
      ),
    ).rejects.toThrow('already connected');
  });
});

describe('provider-safe conversation path', () => {
  it('legacy Meta disconnect leaves a fence even after credentials are removed', async () => {
    const legacy = new MemoryRepository();
    await disconnectGateway(legacy, company.id);
    await legacy.disconnectIntegration(company.id, 'whatsapp');
    await expect(assertCurrentAddress(legacy, company.id, undefined)).rejects.toMatchObject({
      status: 422,
    });
    await selectMeta(legacy, company.id);
    await metaConfigurationBoundary(legacy, company.id, '123456');
    await expect(assertCurrentAddress(legacy, company.id, undefined)).rejects.toMatchObject({
      status: 422,
    });
  });
  it('a replayed completed staff echo does not undo an explicit staff resume', async () => {
    const value = event({ fromMe: true, text: 'staff reply' });
    await receiveGatewayEvent(repo, value);
    const [job] = await repo.listCompanyJobs(company.id);
    await processJob(repo, job.id);
    const conversation = (await repo.findWhatsAppConversation(company.id, address))!;
    await repo.saveConversation(
      { ...conversation, mode: 'bot', version: conversation.version + 1 },
      conversation.version,
    );
    await receiveGatewayEvent(repo, value);
    expect((await repo.getConversation(company.id, conversation.id))?.mode).toBe('bot');
  });
  it('uses the same engine without inventing a phone number for LID messages', async () => {
    await receiveGatewayEvent(repo, event({ text: 'menu' }));
    const [job] = await repo.listCompanyJobs(company.id);
    await processJob(repo, job.id);
    const conversation = await repo.findWhatsAppConversation(company.id, address);
    expect(conversation?.customerPhone).toBe('');
    expect(conversation?.messages.some((m) => m.text.includes('Biryani'))).toBe(true);
    const sends = (await repo.listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.whatsappAddress).toEqual(address);
    expect((await repo.listCompanyJobs(company.id)).some((j) => j.kind === 'sheet_sync')).toBe(
      false,
    );
  });
  it('keeps two unknown-phone LID customers in different FIFO streams and conversations', async () => {
    await receiveGatewayEvent(repo, event());
    await receiveGatewayEvent(repo, event({ peer: '100000002@lid', messageId: 'two' }));
    const due = await repo.listDueJobs(10);
    expect(due).toHaveLength(2);
    for (const job of due) await processJob(repo, job.id);
    const conversations = await repo.listConversations(company.id);
    expect(
      conversations.filter((c) => c.whatsappAddress?.connectionId === connection.id),
    ).toHaveLength(2);
  });
  it('immediately pauses automation on staff phone replies, before processing the echo job', async () => {
    const c = {
      ...createConversation(company.id, '', 'whatsapp', new Date().toISOString()),
      whatsappAddress: address,
      version: 1,
    };
    await repo.saveConversation(c, 0);
    await receiveGatewayEvent(repo, event({ fromMe: true, text: 'I will help you' }));
    const current = await repo.getConversation(company.id, c.id);
    expect(current?.mode).toBe('human');
    expect(current?.lastInboundAt).toBe(c.lastInboundAt);
    expect(await repo.saveConversation({ ...c, version: 2 }, 1)).toBe(false);
  });
  it('turns unsupported media into a staff handoff with no media download', async () => {
    await receiveGatewayEvent(repo, event({ text: '', unsupported: true }));
    const [job] = await repo.listCompanyJobs(company.id);
    expect(job.payload.action).toEqual({ type: 'handoff' });
    await processJob(repo, job.id);
    expect((await repo.findWhatsAppConversation(company.id, address))?.mode).toBe('human');
  });
  it('never sends old queued messages through a replacement connection', async () => {
    const c = {
      ...createConversation(company.id, '', 'whatsapp', new Date().toISOString()),
      whatsappAddress: address,
    };
    await repo.saveConversation(c);
    const job = makeJob(company.id, 'whatsapp_send', {
      conversationId: c.id,
      text: 'hello',
      ...jobAddress(c),
    });
    await repo.insertJob(job);
    await saveConnection(repo, { ...connection, generation: 2 });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))?.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never silently rebinds legacy Meta jobs when a new provider is active', async () => {
    await expect(assertCurrentAddress(repo, company.id, undefined)).rejects.toMatchObject({
      status: 422,
    });
  });
  it('requires a fresh gateway heartbeat for launch readiness', async () => {
    vi.stubEnv('APP_MODE', 'live');
    expect((await readiness(repo, company)).find((c) => c.id === 'whatsapp')?.ready).toBe(true);
    await saveConnection(repo, { ...connection, lastHeartbeatAt: '2020-01-01T00:00:00.000Z' });
    expect((await readiness(repo, company)).find((c) => c.id === 'whatsapp')?.ready).toBe(false);
  });
  it('does not send sandbox chats or invent an unofficial template capability', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const adapter = new LinkedWhatsAppAdapter(repo, company.id, 'job-one');
    await expect(
      adapter.send(
        createConversation(company.id, 'test', 'demo', new Date().toISOString()),
        'hello',
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(adapter.sendStatusTemplate()).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('pauses replies and increments generation when switching back to Meta', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ connectionId: connection.id, generation: 2, status: 'disconnected' }),
            { status: 200 },
          ),
        ),
    );
    const next = await selectMeta(repo, company.id);
    expect(next?.provider).toBe('meta');
    expect(next?.generation).toBe(2);
    expect((await repo.getCompany(company.id))?.botEnabled).toBe(false);
    await expect(assertCurrentAddress(repo, company.id, address)).rejects.toThrow();
  });
  it('does not pause a working provider when gateway health check fails', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const before = await repo.getCompany(company.id);
    await expect(startPairing(repo, company.id, 'qr')).rejects.toThrow('unreachable');
    expect((await repo.getCompany(company.id))?.botEnabled).toBe(before?.botEnabled);
    expect((await repo.getWhatsAppConnection(company.id))?.generation).toBe(1);
  });
});
