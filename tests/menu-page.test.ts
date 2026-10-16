import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEdgeApp } from '../server/edge';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn } from '../server/service';
import { whatsappNumberFor } from '../server/menu';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { MenuLinkStatus, PublicMenu } from '../src/shared/menu';
import type { Company, Conversation, Product } from '../src/shared/types';

// The bearer token is the signed-in user's id, so tests can act as owner or staff.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }),
    },
  }),
}));

const origin = 'https://orderly.example.workers.dev';
const base = 'https://project.supabase.co/orderly/api';
const company = seedCompanies[0]!;
const other = seedCompanies[1]!;
const OWNER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const STAFF = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
let repo: MemoryRepository;

beforeEach(async () => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', 'supabase');
  vi.stubEnv('APP_URL', origin);
  vi.stubEnv('CRON_SECRET', 'test-worker-secret');
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_ANON_KEY', 'fictional-anon-key');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('MENU_LINK_SECRET', '');
  await repo.setMember(company.id, { userId: OWNER, role: 'owner' }, OWNER);
  await repo.setMember(company.id, { userId: STAFF, role: 'staff' }, OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function call(path: string, init: { method?: string; body?: unknown; user?: string } = {}) {
  return createEdgeApp(repo).request(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      Origin: origin,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.user ? { Authorization: `Bearer ${init.user}`, 'x-company-id': company.id } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
async function turnOn(companyId = company.id) {
  const stored = (await repo.getCompany(companyId))!;
  return repo.setMenuLink(companyId, true, stored.slug);
}

describe('public menu page', () => {
  it('answers without sign-in while the private API still needs it', async () => {
    await turnOn();
    const res = await call('/public/menu/dastarkhwan');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    const menu = (await res.json()) as PublicMenu;
    expect(menu.slug).toBe('dastarkhwan');
    expect(menu.restaurant).toMatchObject({ name: company.name, fulfillment: 'both' });
    expect((await call('/companies')).status).toBe(401);
  });

  it('returns only public fields', async () => {
    await repo.saveCompany({
      ...company,
      privacy: { aiDataApproved: true, retentionDays: 30 },
      modelVerification: { fingerprint: 'secret-fingerprint', checkedAt: '2026-10-16T00:00:00Z' },
    });
    await repo.saveIntegration(
      company.id,
      { kind: 'whatsapp', configured: true, status: 'connected', config: { phoneNumberId: '1' } },
      encryptSecret('meta-token'),
    );
    await turnOn();
    const text = await (await call('/public/menu/dastarkhwan')).text();
    for (const key of [
      'ai',
      'bot',
      'privacy',
      'aliases',
      'companyId',
      'integrations',
      'modelVerification',
      'faqs',
      'catalogSource',
    ])
      expect(text, key).not.toContain(`"${key}"`);
    expect(text).not.toContain('secret-fingerprint');
    expect(text).not.toContain('phoneNumberId');
  });

  it('lists deals first and keeps sold-out dishes visible as unavailable', async () => {
    const deal: Product = {
      ...seedProducts[0]!,
      id: randomUUID(),
      name: 'Family Deal',
      category: 'deals',
      imageUrl: 'https://cdn.example/deal.jpg',
    };
    await repo.saveProduct(deal);
    await turnOn();
    const menu = (await (await call('/public/menu/dastarkhwan')).json()) as PublicMenu;
    expect(menu.categories[0]).toMatchObject({ name: 'deals' });
    expect(menu.categories[0]!.items[0]).toMatchObject({
      name: 'Family Deal',
      imageUrl: 'https://cdn.example/deal.jpg',
    });
    expect(menu.categories.map((c) => c.name).slice(1)).toEqual([
      'Rice & Biryani',
      'Karahi & Handi',
      'BBQ',
      'Breads & Sides',
      'Drinks',
      'Desserts',
    ]);
    const daal = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Daal Makhani');
    expect(daal?.available).toBe(false);
  });

  it('is 404 when off or unknown, and refuses other sites', async () => {
    expect((await call('/public/menu/dastarkhwan')).status).toBe(404);
    await repo.setMenuLink(company.id, false, company.slug);
    const off = await call('/public/menu/dastarkhwan');
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({
      error: "This menu isn't available right now.",
      code: 'not_found',
    });
    expect((await call('/public/menu/Not_A_Slug')).status).toBe(404);
    expect((await call(`/public/menu/${'a'.repeat(81)}`)).status).toBe(404);
    await turnOn();
    const foreign = await createEdgeApp(repo).request(`${base}/public/menu/dastarkhwan`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(foreign.status).toBe(403);
  });

  it('never refreshes a Google Sheets menu', async () => {
    await repo.saveCompany({ ...company, catalogSource: 'sheets', catalogSyncedAt: undefined });
    await repo.saveIntegration(
      company.id,
      { kind: 'sheets', configured: true, status: 'connected', config: {} },
      encryptSecret('key'),
    );
    const read = vi.spyOn(GoogleSheetsAdapter.prototype, 'readCatalog');
    await turnOn();
    expect((await call('/public/menu/dastarkhwan')).status).toBe(200);
    expect(read).not.toHaveBeenCalled();
  });

  it('says why ordering is off', async () => {
    await turnOn();
    const reason = async () =>
      ((await (await call('/public/menu/dastarkhwan')).json()) as PublicMenu).ordering;
    expect(await reason()).toMatchObject({ publicOrdering: false, reason: 'no_whatsapp' });
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'connected',
        config: { phoneNumberId: '1', displayPhoneNumber: '923001234567' },
      },
      encryptSecret('meta-token'),
    );
    expect(await reason()).toEqual({
      open: true,
      botOn: true,
      publicOrdering: true,
      whatsappNumber: '923001234567',
    });
    await repo.saveCompany({ ...company, botEnabled: false });
    expect(await reason()).toMatchObject({ publicOrdering: false, reason: 'bot_off' });
    await repo.saveCompany({
      ...company,
      openingHours: { start: '09:00', end: '10:00', days: [] },
    });
    expect(await reason()).toMatchObject({ open: false, reason: 'closed' });
  });
});

describe('owner menu link switch', () => {
  it('turns the link on with a slug that never changes after a rename', async () => {
    const status = await call('/menu-link', {
      method: 'PUT',
      body: { enabled: true },
      user: OWNER,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      enabled: true,
      slug: 'dastarkhwan',
      url: `${origin}/m/dastarkhwan`,
      personalLinks: true,
    });
    const renamed = await call(`/companies/${company.id}`, {
      method: 'PUT',
      body: { ...company, name: 'New Name', slug: 'new-name', botEnabled: false, ai: company.ai },
      user: OWNER,
    });
    expect(renamed.status).toBe(200);
    expect((await repo.getMenuLink(company.id))?.slug).toBe('dastarkhwan');
    const off = await call('/menu-link', { method: 'PUT', body: { enabled: false }, user: OWNER });
    expect(await off.json()).toMatchObject({ enabled: false, slug: 'dastarkhwan' });
    const again = await call('/menu-link', { method: 'PUT', body: { enabled: true }, user: OWNER });
    expect(await again.json()).toMatchObject({ enabled: true, slug: 'dastarkhwan' });
  });

  it('lets staff see the link but not change it', async () => {
    const put = await call('/menu-link', { method: 'PUT', body: { enabled: true }, user: STAFF });
    expect(put.status).toBe(403);
    const get = await call('/menu-link', { user: STAFF });
    expect(get.status).toBe(200);
    expect((await get.json()) as MenuLinkStatus).toMatchObject({ enabled: false, notes: [] });
    const extra = await call('/menu-link', {
      method: 'PUT',
      body: { enabled: true, slug: 'mine' },
      user: OWNER,
    });
    expect(extra.status).toBe(400);
  });

  it('notes a missing WhatsApp number and a paused bot', async () => {
    await repo.saveCompany({ ...company, botEnabled: false });
    const status = (await (
      await call('/menu-link', { method: 'PUT', body: { enabled: true }, user: OWNER })
    ).json()) as MenuLinkStatus;
    expect(status.notes).toEqual([
      'The bot is off, so the page is view-only.',
      "We don't know your WhatsApp number yet, so Instagram and QR customers can view the menu but can't confirm orders. Open your WhatsApp connection and run the connection test.",
    ]);
  });

  it('gives a second business with the same name its own numbered link', async () => {
    await repo.saveCompany({ ...other, slug: 'dastarkhwan-1' });
    await turnOn();
    expect(await repo.setMenuLink(other.id, true, 'dastarkhwan')).toMatchObject({
      slug: 'dastarkhwan-2',
    });
  });
});

describe('WhatsApp number for wa.me links', () => {
  function meta(display?: string) {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/phone_numbers')) return Response.json({ data: [{ id: '123' }] });
      if (url.includes('/subscribed_apps')) return Response.json({ success: true });
      return Response.json({
        id: '123',
        verified_name: 'Dastarkhwan',
        ...(display && { display_phone_number: display }),
      });
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('META_GRAPH_VERSION', 'v23.0');
    return fetch;
  }
  const stored = async () =>
    (await repo.getIntegrations(company.id)).find((i) => i.kind === 'whatsapp')?.config;

  it('keeps the digits Meta reports when the connection is tested', async () => {
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'configured',
        config: { phoneNumberId: '123' },
      },
      encryptSecret('meta-token'),
    );
    meta('+92 300 1234567');
    const res = await call('/integrations/whatsapp/test', { body: {}, user: OWNER });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({
      phoneNumberId: '123',
      displayPhoneNumber: '923001234567',
    });
    vi.unstubAllGlobals();
  });

  it('ignores a number sent by the browser', async () => {
    meta('+92 300 7654321');
    const res = await call('/integrations/whatsapp', {
      body: {
        config: { phoneNumberId: '123', wabaId: '456', displayPhoneNumber: '999999999999' },
        secret: 'meta-token',
      },
      user: OWNER,
    });
    expect(res.status).toBe(200);
    expect((await stored())?.displayPhoneNumber).toBe('923007654321');
    meta();
    await call('/integrations/whatsapp', {
      body: { config: { phoneNumberId: '123', wabaId: '456', displayPhoneNumber: '999999999999' } },
      user: OWNER,
    });
    expect((await stored())?.displayPhoneNumber).toBe('923007654321');
    vi.unstubAllGlobals();
  });

  it('prefers the linked phone while it is connected', async () => {
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'connected',
        config: { displayPhoneNumber: '923001111111' },
      },
      encryptSecret('t'),
    );
    expect(await whatsappNumberFor(repo, company.id)).toBe('923001111111');
    const linked = {
      id: randomUUID(),
      companyId: company.id,
      provider: 'baileys' as const,
      generation: 1,
      revision: 1,
      status: 'connected' as const,
      phoneNumber: '+923002222222',
      updatedAt: new Date().toISOString(),
    };
    await repo.saveWhatsAppConnection(linked, 0);
    expect(await whatsappNumberFor(repo, company.id)).toBe('923002222222');
    await repo.saveWhatsAppConnection({ ...linked, revision: 2, status: 'logged_out' }, 1);
    expect(await whatsappNumberFor(repo, company.id)).toBeUndefined();
  });
});

describe('the bot shares the menu page', () => {
  it('adds the public link to menu replies and marks the send for personalising', async () => {
    await turnOn();
    const conversation = createConversation(
      company.id,
      '923001230000',
      'whatsapp',
      new Date().toISOString(),
    );
    const result = await handleTurn(repo, company, conversation, {
      messageId: 'menu-1',
      text: 'menu',
      now: new Date().toISOString(),
    });
    const url = `${origin}/m/dastarkhwan`;
    expect(result.reply).toContain(`See the full menu and order here: ${url}`);
    const saved = (await repo.getConversation(company.id, conversation.id)) as Conversation;
    const reply = saved.messages.at(-1)!;
    expect(reply).toMatchObject({ role: 'assistant' });
    expect(reply.text).toContain(url);
    expect(JSON.stringify(saved)).not.toContain('#t=');
    const [job] = (await repo.listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(job!.payload).toMatchObject({ menuLink: true, text: result.reply });
    expect(String(job!.payload.text)).not.toContain('#t=');
  });

  it('leaves replies alone while the page is off', async () => {
    const conversation = createConversation(
      company.id,
      '923001230001',
      'whatsapp',
      new Date().toISOString(),
    );
    const result = await handleTurn(repo, company as Company, conversation, {
      messageId: 'menu-2',
      text: 'menu',
      now: new Date().toISOString(),
    });
    expect(result.reply).not.toContain('/m/');
    const [job] = (await repo.listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(job!.payload.menuLink).toBeUndefined();
  });
});
