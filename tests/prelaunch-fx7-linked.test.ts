// Fix package 7, linked phone: Reconnect never restarts a pairing nobody finished without
// approval (api-security-1, gateway-2); a revoked or pre-approval business keeps Disconnect,
// Reconnect and status reads for its existing connection, with separate flags for the dashboard
// (gateway-1, api-security-6); and the gateway's error codes reach the dashboard
// (api-security-5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { gatewayRequest } from '../server/whatsapp/client';
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
const company = seedCompanies[0]!;
let repo: MemoryRepository;
let calls: { path: string; body: Record<string, unknown> }[];
// What the gateway answers to /session; a 200 snapshot by default.
let session: (body: Record<string, unknown>) => Response;

beforeEach(async () => {
  repo = new MemoryRepository();
  calls = [];
  session = (body) =>
    Response.json({
      connectionId: body.connectionId,
      generation: body.generation,
      status: body.action === 'disconnect' ? 'disconnected' : 'connecting',
    });
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('META_APP_SECRET', 'test-app-secret');
  vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
  vi.stubEnv('WHATSAPP_GATEWAY_SECRET', 'gateway-test-secret-with-more-than-32-characters');
  await repo.grantAdmin(ADMIN);
  await repo.setMember(company.id, { userId: OWNER, role: 'owner' }, ADMIN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/session') return session(body);
      if (path === '/status')
        return Response.json({
          connectionId: body.connectionId,
          generation: body.generation,
          status: 'connected',
        });
      throw new Error('Unexpected network request');
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
const setApproval = (value: boolean) =>
  call(`/admin/businesses/${company.id}/linked-device`, { allowed: value }, 'admin-session', 'PUT');
// The business's stored connection becomes a linked phone with these fields.
async function linkedPhone(fields: Partial<WhatsAppConnection> = {}) {
  const current = await repo.getWhatsAppConnection(company.id);
  const revision = (current?.revision ?? 0) + 1;
  const connection: WhatsAppConnection = {
    id: current?.id ?? randomUUID(),
    companyId: company.id,
    provider: 'baileys',
    generation: current?.generation ?? 1,
    revision,
    status: 'connected',
    accountJid: '923000000001@s.whatsapp.net',
    lastHeartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
  };
  expect(await repo.saveWhatsAppConnection(connection, revision - 1)).toBe(true);
  return connection;
}
// A pairing nobody finished: parked by the gateway, its account never known.
const expiredPairing = () =>
  linkedPhone({ status: 'error', errorCode: 'PAIRING_EXPIRED', accountJid: undefined });
const reconnect = () => call('/whatsapp/reconnect', {});
const sessionCalls = () => calls.filter((c) => c.path === '/session');
const access = async () =>
  (await (await call('/whatsapp/connection')).json()) as Record<string, unknown>;

describe('api-security-1, gateway-2: Reconnect never restarts a pairing nobody finished', () => {
  it('refuses a revoked business whose pairing expired, without asking the gateway', async () => {
    await expiredPairing();
    expect((await setApproval(true)).status).toBe(200);
    expect((await setApproval(false)).status).toBe(200);
    const refused = await reconnect();
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('Start a new pairing first.');
    expect(sessionCalls()).toHaveLength(0);
  });

  it('sends even an approved business through Start pairing once its pairing expired', async () => {
    await expiredPairing();
    expect((await setApproval(true)).status).toBe(200);
    expect((await reconnect()).status).toBe(409);
    expect(sessionCalls()).toHaveLength(0);
    // Another unfinished pairing of an approved business may be restarted.
    const other = await linkedPhone({
      status: 'error',
      errorCode: 'SESSION_CRASH',
      accountJid: undefined,
    });
    expect((await reconnect()).status).toBe(200);
    expect(sessionCalls()).toEqual([
      {
        path: '/session',
        body: { connectionId: other.id, generation: 1, action: 'reconnect' },
      },
    ]);
  });

  it('refuses an unfinished pairing of a business from before approvals', async () => {
    await linkedPhone({
      status: 'error',
      errorCode: 'GATEWAY_START_FAILED',
      accountJid: undefined,
    });
    expect((await reconnect()).status).toBe(409);
    expect(sessionCalls()).toHaveLength(0);
  });

  it('keeps reconnecting a phone that finished pairing, approved or not', async () => {
    // From before approvals, failed: still its own session.
    const phone = await linkedPhone({ status: 'error', errorCode: 'SESSION_CRASH' });
    expect((await reconnect()).status).toBe(200);
    // Revoked: the session it has keeps working until it ends.
    expect((await setApproval(false)).status).toBe(200);
    expect((await reconnect()).status).toBe(200);
    expect(sessionCalls().map((c) => c.body)).toEqual([
      { connectionId: phone.id, generation: 1, action: 'reconnect' },
      { connectionId: phone.id, generation: 1, action: 'reconnect' },
    ]);
  });

  it('allows 6 reconnects a minute per business', async () => {
    await linkedPhone({ status: 'error', errorCode: 'SESSION_CRASH' });
    for (let i = 0; i < 6; i++) expect((await reconnect()).status).toBe(200);
    const limited = await reconnect();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe('Too many reconnect attempts. Wait a minute.');
    expect(sessionCalls()).toHaveLength(6);
  });
});

describe('gateway-1, api-security-6: what the dashboard may offer for an existing linked phone', () => {
  it('keeps Disconnect, Reconnect and status reads for a revoked business with a connected phone', async () => {
    await linkedPhone({ lastHeartbeatAt: new Date(Date.now() - 600000).toISOString() });
    expect((await setApproval(false)).status).toBe(200);
    expect(await access()).toMatchObject({
      // Older dashboards keep reading these as before.
      enabled: false,
      gatewayEnabled: true,
      pairingAllowed: false,
      canPair: false,
      canManage: true,
      canReconnect: true,
    });
    const status = await call('/whatsapp/pairing-status', {});
    expect(status.status).toBe(200);
    expect((await call('/whatsapp/disconnect', { confirmed: true })).status).toBe(200);
    expect(await access()).toMatchObject({ canManage: false, canReconnect: false, canPair: false });
  });

  it('keeps them for a phone from before approvals that failed, but no new pairing', async () => {
    await linkedPhone({ status: 'error', errorCode: 'SESSION_CRASH' });
    expect(await access()).toMatchObject({
      enabled: false,
      canPair: false,
      canManage: true,
      canReconnect: true,
    });
  });

  it('offers Start pairing, not Reconnect, once an approved pairing expired', async () => {
    await expiredPairing();
    expect((await setApproval(true)).status).toBe(200);
    expect(await access()).toMatchObject({
      enabled: true,
      canPair: true,
      canManage: true,
      canReconnect: false,
    });
  });

  it('offers nothing linked-phone without the gateway, except checking and disconnecting', async () => {
    await linkedPhone();
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'false');
    expect(await access()).toMatchObject({
      gatewayEnabled: false,
      canPair: false,
      canManage: true,
      canReconnect: false,
    });
  });
});

describe('api-security-5: the gateway’s error codes reach the dashboard', () => {
  beforeEach(() => linkedPhone({ status: 'error', errorCode: 'SESSION_CRASH' }));

  it.each([
    [
      'SESSION_CAPACITY_REACHED',
      503,
      503,
      'Orderly’s linked-phone service is full right now. Contact Orderly support.',
    ],
    ['PAIRING_REQUIRED', 409, 409, 'Start a new pairing first.'],
    [
      'STALE_GENERATION',
      409,
      409,
      'This WhatsApp connection changed meanwhile. Reload the page and try again.',
    ],
    [
      'CONNECTION_BUSY',
      409,
      409,
      'WhatsApp gateway rejected the request (409). Check the connection status.',
    ],
  ])('says %s in plain words, with the code', async (code, status, answered, error) => {
    session = () => Response.json({ errorCode: code }, { status });
    const response = await reconnect();
    expect(response.status).toBe(answered);
    expect(await response.json()).toEqual({ error, code });
  });

  it('never passes on a malformed code, and says an unreachable gateway plainly', async () => {
    session = () => Response.json({ errorCode: 'not a code <script>' }, { status: 503 });
    const odd = await reconnect();
    expect(await odd.json()).toEqual({
      error: 'WhatsApp gateway rejected the request (503). Check the connection status.',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const down = await reconnect();
    expect(down.status).toBe(503);
    expect((await down.json()).error).toBe(
      'The WhatsApp gateway is unreachable right now. Try again in a few minutes.',
    );
    // Only a send can be left pending.
    await expect(gatewayRequest('/send', {})).rejects.toThrow('A send may still be pending');
  });
});
