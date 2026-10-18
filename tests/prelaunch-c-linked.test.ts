import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import {
  LINKED_DEVICE_CONSENT_VERSION,
  disconnectGateway,
  receiveGatewayEvent,
  selectMeta,
  startPairing,
} from '../server/whatsapp/connections';
import { seedCompanies } from '../src/shared/seed';
import type { WhatsAppConnection } from '../src/shared/whatsapp';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: token === 'admin-session' ? ADMIN : OWNER } },
        error: null,
      }),
    },
    rpc: async () => ({ error: { message: 'no scheduler in tests' } }),
  }),
}));
const ADMIN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

const company = seedCompanies[0];
const secret = 'gateway-test-secret-with-more-than-32-characters';
const consent = { version: LINKED_DEVICE_CONSENT_VERSION, accepted: true };
let repo: MemoryRepository;
beforeEach(async () => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('META_APP_SECRET', 'test-app-secret');
  vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
  vi.stubEnv('WHATSAPP_GATEWAY_SECRET', secret);
  await repo.grantAdmin(ADMIN);
  await repo.setMember(company.id, { userId: OWNER, role: 'owner' }, ADMIN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The gateway, answering /health and /session; every call is recorded.
function gateway(
  options: {
    health?: unknown;
    session?: (body: Record<string, unknown>) => Response | Promise<Response>;
  } = {},
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/health')
        return Response.json(options.health ?? { ok: true, workers: 0, capacity: 1 });
      if (path === '/session')
        return options.session
          ? options.session(body)
          : Response.json({
              connectionId: body.connectionId,
              generation: body.generation,
              status: body.action === 'disconnect' ? 'disconnected' : 'awaiting_pairing',
              ...(body.action === 'pair' && { code: 'ABCD1234' }),
            });
      throw new Error('Unexpected network request');
    }),
  );
  return calls;
}
const full = () => Response.json({ errorCode: 'SESSION_CAPACITY_REACHED' }, { status: 503 });
async function metaTenant() {
  await repo.saveIntegration(
    company.id,
    {
      kind: 'whatsapp',
      configured: true,
      status: 'connected',
      config: { phoneNumberId: '777', ownershipVerifiedAt: new Date().toISOString() },
    },
    encryptSecret('meta-token'),
  );
  const meta: WhatsAppConnection = {
    id: randomUUID(),
    companyId: company.id,
    provider: 'meta',
    generation: 1,
    revision: 1,
    status: 'connected',
    updatedAt: new Date().toISOString(),
  };
  await repo.saveWhatsAppConnection(meta, 0);
  return meta;
}
async function linkedTenant() {
  const linked: WhatsAppConnection = {
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
  await repo.saveWhatsAppConnection(linked, 0);
  return linked;
}
const connection = async () => (await repo.getWhatsAppConnection(company.id))!;
const botEnabled = async () => (await repo.getCompany(company.id))!.botEnabled;
async function metaMessageArrives() {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '777' },
              messages: [
                {
                  id: `wamid.${randomUUID()}`,
                  from: '923001112233',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'menu' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const before = (await repo.listCompanyJobs(company.id)).length;
  await createApp(repo).request('http://127.0.0.1/api/webhooks/whatsapp', {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`,
    },
  });
  return (await repo.listCompanyJobs(company.id)).length > before;
}
function call(path: string, body?: unknown, token = 'owner-session', method?: string) {
  return createApp(repo).request(`http://127.0.0.1/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-company-id': company.id,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('a linked-phone pairing that cannot start', () => {
  it('changes nothing when the gateway is full or restarting', async () => {
    const meta = await metaTenant();
    for (const health of [
      { ok: true, workers: 1, capacity: 1 },
      { ok: false, workers: 0, capacity: 1 },
    ]) {
      const calls = gateway({ health });
      await expect(startPairing(repo, company.id, 'qr')).rejects.toMatchObject({ status: 503 });
      expect(calls.map((c) => c.path)).toEqual(['/health']);
      expect(await connection()).toEqual(meta);
      expect(await botEnabled()).toBe(true);
    }
    expect(await metaMessageArrives()).toBe(true);
  });

  it('puts an official route back when the gateway refuses, so Meta messages still arrive', async () => {
    const meta = await metaTenant();
    const calls = gateway({
      session: (body) =>
        body.action === 'pair'
          ? full()
          : Response.json({
              connectionId: body.connectionId,
              generation: body.generation,
              status: 'disconnected',
            }),
    });
    await expect(startPairing(repo, company.id, 'qr')).rejects.toMatchObject({ status: 503 });
    expect(await connection()).toMatchObject({
      id: meta.id,
      provider: 'meta',
      status: 'connected',
      generation: 3,
    });
    expect((await connection()).errorCode).toBeUndefined();
    expect(await botEnabled()).toBe(true);
    // The gateway is told to drop the attempt, in case it started after all.
    expect(calls.at(-1)).toMatchObject({
      path: '/session',
      body: { connectionId: meta.id, generation: 3, action: 'disconnect' },
    });
    expect(await metaMessageArrives()).toBe(true);
  });

  it('still ends on the official route when a gateway status event lands meanwhile', async () => {
    await metaTenant();
    gateway({
      session: async (body) => {
        if (body.action !== 'pair')
          return Response.json({
            connectionId: body.connectionId,
            generation: body.generation,
            status: 'disconnected',
          });
        await receiveGatewayEvent(repo, {
          eventId: randomUUID(),
          connectionId: String(body.connectionId),
          generation: Number(body.generation),
          type: 'status',
          status: 'connecting',
          timestamp: new Date().toISOString(),
        });
        return full();
      },
    });
    await expect(startPairing(repo, company.id, 'code', '923001234567')).rejects.toBeTruthy();
    expect(await connection()).toMatchObject({ provider: 'meta', generation: 3 });
  });

  it('keeps a failed re-pair of a linked phone marked as failed', async () => {
    await linkedTenant();
    gateway({ session: () => full() });
    await expect(startPairing(repo, company.id, 'qr')).rejects.toMatchObject({ status: 503 });
    expect(await connection()).toMatchObject({
      provider: 'baileys',
      status: 'error',
      errorCode: 'GATEWAY_START_FAILED',
      generation: 2,
    });
    expect(await botEnabled()).toBe(false);
  });
});

describe('leaving the linked phone never depends on the gateway', () => {
  it.each([
    ['switched off', () => vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'false')],
    ['unreachable', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))],
  ])('switches to the official route when the gateway is %s', async (_case, breakGateway) => {
    await metaTenant().then(() => undefined);
    const linked = await repo.getWhatsAppConnection(company.id);
    await repo.saveWhatsAppConnection(
      {
        ...linked!,
        provider: 'baileys',
        revision: 2,
        generation: 2,
        updatedAt: new Date().toISOString(),
      },
      1,
    );
    breakGateway();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const next = await selectMeta(repo, company.id);
    expect(next).toMatchObject({ provider: 'meta', status: 'connected', generation: 3 });
    expect(next?.gatewayCleanupPending).toBe(true);
    expect(await connection()).not.toHaveProperty('gatewayCleanupPending');
    expect(await metaMessageArrives()).toBe(true);
  });

  it('disconnects, in the API too, while the gateway is switched off', async () => {
    await linkedTenant();
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'false');
    const result = await disconnectGateway(repo, company.id);
    expect(result).toMatchObject({
      status: 'disconnected',
      generation: 2,
      gatewayCleanupPending: true,
    });
    const response = await call('/whatsapp/disconnect', { confirmed: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, gatewayCleanupPending: true });
    const removed = await call('/integrations/whatsapp', undefined, 'owner-session', 'DELETE');
    expect(removed.status).toBe(200);
    expect(await connection()).toMatchObject({ status: 'disconnected', generation: 4 });
  });
});

describe('who may pair a new linked phone', () => {
  const pair = (body: Record<string, unknown> = {}) =>
    call('/whatsapp/pair', {
      method: 'qr',
      riskAccepted: true,
      switchConfirmed: true,
      consent,
      ...body,
    });

  it('needs the Orderly admin’s approval for a business on the official route', async () => {
    await metaTenant();
    const calls = gateway();
    const status = await call('/whatsapp/connection');
    expect(await status.json()).toMatchObject({
      enabled: false,
      gatewayEnabled: true,
      pairingAllowed: false,
      consentVersion: LINKED_DEVICE_CONSENT_VERSION,
    });
    const refused = await pair();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(
      'Linked-phone pairing needs approval from Orderly support. Use the official WhatsApp Business Platform instead.',
    );
    expect(calls).toHaveLength(0);
    expect((await connection()).provider).toBe('meta');
    // Owners cannot approve themselves; the admin can.
    expect(
      (
        await call(
          `/admin/businesses/${company.id}/linked-device`,
          { allowed: true },
          'owner-session',
          'PUT',
        )
      ).status,
    ).toBe(403);
    const approved = await call(
      `/admin/businesses/${company.id}/linked-device`,
      { allowed: true },
      'admin-session',
      'PUT',
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ ok: true, linkedDeviceAllowed: true });
    expect((await repo.getCompany(company.id))?.linkedDeviceAllowed).toBe(true);
    expect((await repo.listTraces(company.id)).map((t) => t.action)).toContain(
      'admin.linked_device.allowed',
    );
    expect((await (await call('/whatsapp/connection')).json()).enabled).toBe(true);
    const paired = await pair();
    expect(paired.status).toBe(200);
    expect(await connection()).toMatchObject({
      provider: 'baileys',
      linkedDeviceConsent: {
        userId: OWNER,
        at: expect.any(String),
        version: LINKED_DEVICE_CONSENT_VERSION,
      },
    });
    expect((await repo.listTraces(company.id)).map((t) => t.action)).toContain(
      `whatsapp.linked_risk_accepted ${LINKED_DEVICE_CONSENT_VERSION}`,
    );
  });

  it('keeps a business that already uses a linked phone able to re-pair', async () => {
    await linkedTenant();
    gateway();
    expect((await (await call('/whatsapp/connection')).json()).pairingAllowed).toBe(true);
    expect((await pair()).status).toBe(200);
  });

  it('asks a page from before the consent record to reload', async () => {
    await linkedTenant();
    const calls = gateway();
    for (const body of [{ consent: undefined }, { consent: { version: 'old', accepted: true } }]) {
      const response = await pair(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Please reload the page to continue.');
    }
    expect(calls).toHaveLength(0);
  });

  it('never blocks disconnecting or switching back for a business without approval', async () => {
    await metaTenant();
    gateway();
    expect((await call('/whatsapp/select-meta', { confirmed: true })).status).toBe(200);
    expect((await call('/whatsapp/disconnect', { confirmed: true })).status).toBe(200);
  });
});
