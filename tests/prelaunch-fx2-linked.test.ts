// Fix package 2 (tests-ci-2, api-security-5): pairing a new linked phone needs the Orderly admin's
// approval. Only a business from before approvals whose linked phone is still in use is let
// through, and an admin's revoke always wins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { LINKED_DEVICE_CONSENT_VERSION } from '../server/whatsapp/connections';
import { pairingAllowed } from '../server/whatsapp/routes';
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
const consent = { version: LINKED_DEVICE_CONSENT_VERSION, accepted: true };
const REFUSED =
  'Linked-phone pairing needs approval from Orderly support. Use the official WhatsApp Business Platform instead.';
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
  vi.stubEnv('WHATSAPP_GATEWAY_SECRET', 'gateway-test-secret-with-more-than-32-characters');
  await repo.grantAdmin(ADMIN);
  await repo.setMember(company.id, { userId: OWNER, role: 'owner' }, ADMIN);
  // The gateway: every session call succeeds; health has room.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === '/health') return Response.json({ ok: true, workers: 0, capacity: 1 });
      if (path === '/session')
        return Response.json({
          connectionId: body.connectionId,
          generation: body.generation,
          status: body.action === 'disconnect' ? 'disconnected' : 'awaiting_pairing',
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
const pair = (body: Record<string, unknown> = {}) =>
  call('/whatsapp/pair', {
    method: 'qr',
    riskAccepted: true,
    switchConfirmed: true,
    consent,
    ...body,
  });
const allowed = async () =>
  ((await (await call('/whatsapp/connection')).json()) as { pairingAllowed: boolean })
    .pairingAllowed;
const setApproval = (value: boolean) =>
  call(`/admin/businesses/${company.id}/linked-device`, { allowed: value }, 'admin-session', 'PUT');
const phone = (fields: Partial<WhatsAppConnection> = {}): WhatsAppConnection => ({
  id: randomUUID(),
  companyId: company.id,
  provider: 'baileys',
  generation: 1,
  revision: 1,
  status: 'connected',
  accountJid: '923000000001@s.whatsapp.net',
  lastHeartbeatAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...fields,
});
// The business's stored connection: a linked phone with these fields.
async function linkedPhone(fields: Partial<WhatsAppConnection> = {}) {
  const connection = phone(fields);
  expect(await repo.saveWhatsAppConnection(connection, 0)).toBe(true);
  return connection;
}

describe('a business from before approvals', () => {
  it('may pair again while its linked phone is in use', async () => {
    for (const status of ['connected', 'connecting', 'reconnecting', 'awaiting_pairing'] as const)
      expect(pairingAllowed(company, phone({ status })), status).toBe(true);
    // Never the official route, and never without a connection.
    expect(pairingAllowed(company, phone({ provider: 'meta' }))).toBe(false);
    expect(pairingAllowed(company, undefined)).toBe(false);
    await linkedPhone();
    expect(await allowed()).toBe(true);
    expect((await pair()).status).toBe(200);
  });

  it('needs approval once it disconnected its linked phone', async () => {
    await linkedPhone();
    expect((await call('/whatsapp/disconnect', { confirmed: true })).status).toBe(200);
    expect((await repo.getWhatsAppConnection(company.id))!.status).toBe('disconnected');
    expect(await allowed()).toBe(false);
    const refused = await pair();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(REFUSED);
  });

  it('needs approval once WhatsApp was removed under Integrations', async () => {
    await linkedPhone();
    expect(
      (await call('/integrations/whatsapp', undefined, 'owner-session', 'DELETE')).status,
    ).toBe(200);
    expect(await allowed()).toBe(false);
    expect((await pair()).status).toBe(403);
  });

  it('needs approval when its phone was logged out or failed', async () => {
    for (const status of ['logged_out', 'error', 'disconnected'] as const)
      expect(pairingAllowed(company, phone({ status })), status).toBe(false);
    await linkedPhone({ status: 'logged_out' });
    expect((await pair()).status).toBe(403);
    // Approved, it may pair again.
    expect((await setApproval(true)).status).toBe(200);
    expect((await pair()).status).toBe(200);
  });
});

describe('the admin’s revoke', () => {
  it('stops every further pairing, even with the linked phone still connected', async () => {
    await linkedPhone();
    expect((await setApproval(true)).status).toBe(200);
    expect(await allowed()).toBe(true);
    const revoked = await setApproval(false);
    expect(await revoked.json()).toEqual({ ok: true, linkedDeviceAllowed: false });
    expect((await repo.listTraces(company.id)).map((t) => t.action)).toContain(
      'admin.linked_device.revoked',
    );
    expect(await allowed()).toBe(false);
    expect((await (await call('/whatsapp/connection')).json()).enabled).toBe(false);
    const refused = await pair();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(REFUSED);
    // The current session can still be ended or moved to the official route.
    expect((await call('/whatsapp/disconnect', { confirmed: true })).status).toBe(200);
    expect(pairingAllowed({ ...company, linkedDeviceAllowed: false }, undefined)).toBe(false);
  });

  it('is checked before the consent notice, so an old page is told about the approval', async () => {
    const refused = await pair({ consent: undefined });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(REFUSED);
  });
});
