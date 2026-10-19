// FX-11 (gateway-1, sweep P3): the WhatsApp page reads the server's own linked-phone decisions
// (canPair, canManage, canReconnect from GET /whatsapp/connection). The real response body goes
// through the page's own mapping into linkedControls here, so the two sides cannot drift apart:
// Reconnect shows exactly where POST /reconnect accepts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { ApiError } from '../src/lib/api';
import { seedCompanies } from '../src/shared/seed';
import type { WhatsAppConnection } from '../src/shared/whatsapp';
import {
  linkedControls,
  PAIRING_ENDED,
  pairingAccess,
  reconnectMessage,
  type PairingAccess,
} from '../src/components/WhatsAppConnection';

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
  // The gateway answers every session and status request; nothing leaves the test.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === '/session' || path === '/status')
        return Response.json({
          connectionId: body.connectionId,
          generation: body.generation,
          status: path === '/status' ? 'connected' : 'connecting',
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
/** What the page shows for the business's connection, from the real GET /connection body. */
async function controls() {
  const response = await call('/whatsapp/connection');
  expect(response.status).toBe(200);
  const { connection, ...result } = (await response.json()) as PairingAccess & {
    connection: WhatsAppConnection | null;
  };
  return linkedControls(pairingAccess(result), connection);
}

type Approval = 'before approvals' | 'approved' | 'revoked';
async function business(approval: Approval, fields: Partial<WhatsAppConnection>) {
  await linkedPhone(fields);
  if (approval !== 'before approvals')
    expect((await setApproval(approval === 'approved')).status).toBe(200);
}
const unfinished = { accountJid: undefined };
const PHONES: [string, Partial<WhatsAppConnection>][] = [
  ['connected', {}],
  ['paired, then crashed', { status: 'error', errorCode: 'SESSION_CRASH' }],
  ['paired, reconnecting', { status: 'reconnecting', errorCode: 'DISCONNECT_408' }],
  ['pairing expired', { status: 'error', errorCode: 'PAIRING_EXPIRED', ...unfinished }],
  [
    'unfinished, gateway full',
    { status: 'error', errorCode: 'SESSION_CAPACITY_REACHED', ...unfinished },
  ],
  ['unfinished, crashed', { status: 'error', errorCode: 'SESSION_CRASH', ...unfinished }],
  ['waiting for its pairing', { status: 'awaiting_pairing', ...unfinished }],
  ['logged out', { status: 'logged_out', errorCode: 'LOGGED_OUT' }],
  ['disconnected', { status: 'disconnected' }],
];
const CASES = (['before approvals', 'approved', 'revoked'] as const).flatMap((approval) =>
  PHONES.map(([name, fields]) => [approval, name, fields] as const),
);

describe('the WhatsApp page and GET /whatsapp/connection agree', () => {
  it.each(CASES)(
    '%s, %s: Reconnect shows exactly where the server accepts it',
    async (approval, _name, fields) => {
      await business(approval, fields);
      const shown = await controls();
      const reconnect = await call('/whatsapp/reconnect', {});
      expect(shown.reconnect).toBe(reconnect.status === 200);
      if (!shown.reconnect) expect(reconnect.status).toBe(409);
      // Every linked phone that is not disconnected can be checked and disconnected.
      const live = fields.status !== 'disconnected';
      expect(shown).toMatchObject({ disconnect: live, poll: live });
      if (shown.poll) expect((await call('/whatsapp/pairing-status', {})).status).toBe(200);
    },
  );

  it('keeps every control but a new pairing for a revoked business whose phone is connected', async () => {
    await business('revoked', {});
    expect(await controls()).toEqual({
      pair: false,
      reconnect: true,
      disconnect: true,
      poll: true,
    });
  });

  it('offers no dead Reconnect for a pairing that ended unfinished', async () => {
    // From before approvals, parked as expired by the gateway's restore.
    await business('before approvals', {
      status: 'error',
      errorCode: 'PAIRING_EXPIRED',
      ...unfinished,
    });
    expect(await controls()).toEqual({
      pair: false,
      reconnect: false,
      disconnect: true,
      poll: true,
    });
  });

  it('offers Start pairing, not Reconnect, once an approved pairing expired', async () => {
    await business('approved', { status: 'error', errorCode: 'PAIRING_EXPIRED', ...unfinished });
    expect(await controls()).toEqual({
      pair: true,
      reconnect: false,
      disconnect: true,
      poll: true,
    });
  });

  it('shows nothing for a revoked business whose phone is already disconnected', async () => {
    await business('revoked', { status: 'disconnected' });
    expect(await controls()).toEqual({
      pair: false,
      reconnect: false,
      disconnect: false,
      poll: false,
    });
  });

  it('keeps Disconnect, and only that, while the gateway is switched off', async () => {
    await business('approved', {});
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'false');
    expect(await controls()).toEqual({
      pair: false,
      reconnect: false,
      disconnect: true,
      poll: false,
    });
  });

  it('still offers a new pairing to an approved business without a linked phone', async () => {
    expect((await setApproval(true)).status).toBe(200);
    expect(await controls()).toEqual({
      pair: true,
      reconnect: false,
      disconnect: false,
      poll: false,
    });
  });
});

describe('a Reconnect refused because the pairing ended after the page loaded', () => {
  // The page reloads the connection after the refusal and words it for what it finds.
  async function refused() {
    const response = await call('/whatsapp/reconnect', {});
    expect(response.status).toBe(409);
    const body = await response.json();
    const reloaded = (await (await call('/whatsapp/connection')).json()) as PairingAccess;
    return reconnectMessage(new ApiError(body.error, response.status, body), !!reloaded.enabled);
  }

  it('says the pairing ended, not “Start a new pairing first”, where none can start', async () => {
    // Opened while a pairing from before approvals was still running…
    await business('before approvals', { status: 'connecting', ...unfinished });
    expect((await controls()).reconnect).toBe(true);
    // …which then expired.
    await linkedPhone({ status: 'error', errorCode: 'PAIRING_EXPIRED', ...unfinished });
    expect(await refused()).toBe(PAIRING_ENDED);
    expect(await controls()).toMatchObject({ pair: false, reconnect: false });
  });

  it('keeps the server’s words where Start pairing is on the page', async () => {
    await business('approved', { status: 'connecting', ...unfinished });
    await linkedPhone({ status: 'error', errorCode: 'PAIRING_EXPIRED', ...unfinished });
    expect(await refused()).toBe('Start a new pairing first.');
    expect(await controls()).toMatchObject({ pair: true, reconnect: false });
  });

  it('passes on other refusals as before', () => {
    const busy = new ApiError('Busy.', 409, { error: 'Busy.', code: 'CONNECTION_BUSY' });
    expect(reconnectMessage(busy, false)).toBe('Busy.');
    expect(reconnectMessage(new ApiError('Too many.', 429, {}), false)).toBe('Too many.');
  });

  it('is what the page does', () => {
    const page = readFileSync(join(process.cwd(), 'src/components/WhatsAppConnection.tsx'), 'utf8');
    expect(page).toMatch(
      /if \(action === 'reconnect'\) \{\s*const saved = await loadConnection\(\)\.catch\(\(\) => undefined\);\s*if \(saved\) \{\s*showConnection\(saved\);\s*canPair = !!saved\.enabled;/,
    );
    expect(page).toContain('? reconnectMessage(e, canPair)');
  });
});
