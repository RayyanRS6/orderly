import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEdgeApp } from '../server/edge';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn, processJob } from '../server/service';
import { personalMenuText, whatsappNumberFor } from '../server/menu';
import { signMenuToken, verifyMenuToken } from '../server/menu-token';
import { makeJob } from '../server/jobs';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import { WhatsAppAdapter } from '../server/integrations/whatsapp';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import {
  normalizeTypedPhone,
  type MenuLinkStatus,
  type MenuSession,
  type PublicMenu,
  type WebCart,
} from '../src/shared/menu';
import type { Company, Conversation, ModelInterpretation, Product } from '../src/shared/types';
import type { WhatsAppConnection } from '../src/shared/whatsapp';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

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

// ── Personal one-tap links ──────────────────────────────────────────────────────────────────

const url = `${origin}/m/dastarkhwan`;
const biryani = seedProducts.find((p) => p.name === 'Chicken Biryani')!;
const cart: WebCart = {
  items: [{ productId: biryani.id, quantity: 2, modifierIds: [], notes: '' }],
  fulfillment: 'pickup',
  customerName: 'Ali',
};
async function customer(phone = '923001230000', changes: Partial<Conversation> = {}) {
  const conversation: Conversation = {
    ...createConversation(
      company.id,
      phone,
      'whatsapp',
      new Date(Date.now() - 10 * 60000).toISOString(),
    ),
    version: 1,
    ...changes,
  };
  expect(await repo.saveConversation(conversation, 0)).toBe(true);
  return conversation;
}
const tokenFor = (
  conversation: Conversation,
  issuedAt = new Date().toISOString(),
  jobId = randomUUID(),
  companyId = company.id,
) =>
  signMenuToken(
    companyId,
    {
      conversationId: conversation.id,
      connectionId: conversation.whatsappAddress?.connectionId,
      generation: conversation.whatsappAddress?.generation,
    },
    { jobId, issuedAt },
  )!;
const session = async (token: string, slug = 'dastarkhwan') =>
  (await (await call(`/public/menu/${slug}/session`, { body: { token } })).json()) as MenuSession;
const order = (token: string, body: Record<string, unknown> = {}) =>
  call('/public/menu/dastarkhwan/orders', {
    body: { token, cart, expectedTotal: 90000, ...body },
  });
const update = async (conversation: Conversation, changes: Partial<Conversation>) => {
  const current = (await repo.getConversation(company.id, conversation.id))!;
  expect(
    await repo.saveConversation(
      { ...current, ...changes, version: current.version + 1 },
      current.version,
    ),
  ).toBe(true);
};
async function linkedPhone(): Promise<WhatsAppConnection> {
  const connection: WhatsAppConnection = {
    id: randomUUID(),
    companyId: company.id,
    provider: 'baileys',
    generation: 1,
    revision: 1,
    status: 'connected',
    phoneNumber: '+923009990000',
    updatedAt: new Date().toISOString(),
  };
  await repo.saveWhatsAppConnection(connection, 0);
  return connection;
}
const meta = () =>
  repo.saveIntegration(
    company.id,
    {
      kind: 'whatsapp',
      configured: true,
      status: 'connected',
      config: { phoneNumberId: '123', displayPhoneNumber: '923001112233' },
    },
    encryptSecret('meta-token'),
  );

describe('personal link at send time', () => {
  beforeEach(async () => {
    await turnOn();
    await meta();
  });
  async function menuReply(conversation: Conversation) {
    await handleTurn(repo, (await repo.getCompany(company.id))!, conversation, {
      messageId: randomUUID(),
      text: 'menu',
      now: new Date().toISOString(),
    });
    const jobs = (await repo.listCompanyJobs(company.id)).filter((j) => j.kind === 'whatsapp_send');
    return jobs.at(0)!;
  }

  it('sends the customer their own link while storing only the public one', async () => {
    const send = vi.spyOn(WhatsAppAdapter.prototype, 'send').mockResolvedValue('wamid.sent');
    const conversation = await customer();
    const job = await menuReply(conversation);
    expect(job.payload).toMatchObject({ menuLink: true });
    await processJob(repo, job.id);
    expect(send).toHaveBeenCalledOnce();
    const sent = String(send.mock.calls[0]![1]);
    const token = sent.match(/#t=([A-Za-z0-9_-]+)/)?.[1];
    expect(sent).toBe(String(job.payload.text).replace(url, `${url}#t=${token}`));
    const checked = verifyMenuToken(company.id, token!);
    expect(checked.ok && checked.claims.conversationId).toBe(conversation.id);
    const stored = JSON.stringify([
      await repo.getConversation(company.id, conversation.id),
      await repo.getJob(job.id),
      await repo.listTraces(company.id),
    ]);
    expect(stored).not.toContain('#t=');
    expect(stored).not.toContain(token!);
  });

  it('sends exactly the same text when a send is retried', async () => {
    const send = vi
      .spyOn(WhatsAppAdapter.prototype, 'send')
      .mockRejectedValueOnce(new Error('Timed out after the message went out'))
      .mockResolvedValueOnce('wamid.sent');
    const job = await menuReply(await customer());
    await expect(processJob(repo, job.id)).rejects.toThrow('waiting to retry');
    const waiting = (await repo.getJob(job.id))!;
    await repo.saveJob({ ...waiting, nextRunAt: new Date().toISOString() });
    await processJob(repo, job.id);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toBe(send.mock.calls[0]![1]);
    expect(String(send.mock.calls[0]![1])).toContain('#t=');
  });

  it('falls back to the public link when the personal text would be too long', async () => {
    const conversation = await customer();
    const job = makeJob(company.id, 'whatsapp_send', { conversationId: conversation.id });
    const long = `${'x'.repeat(4096 - url.length - 40)}\n${url}`;
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(await personalMenuText(repo, company, conversation, job, long)).toBe(long);
    const short = `Menu: ${url}\nSee also ${url}-2 and ${url}/x`;
    expect(await personalMenuText(repo, company, conversation, job, short)).toMatch(
      new RegExp(`^Menu: ${url}#t=[A-Za-z0-9_-]{87}\\nSee also ${url}-2 and ${url}/x$`),
    );
    await repo.setMenuLink(company.id, false, company.slug);
    expect(await personalMenuText(repo, company, conversation, job, short)).toBe(short);
  });

  it('never shows the AI a personal link', async () => {
    vi.stubEnv('MODEL_PRICING_JSON', '');
    await repo.saveCompany({
      ...company,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    });
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-anthropic-key'),
    );
    const menu: ModelInterpretation = {
      actions: [{ type: 'menu' }],
      response: { text: 'Here is our menu.', askFor: 'items' },
    };
    generate.mockReset();
    generate.mockResolvedValue({ output: menu, usage: { inputTokens: 100, outputTokens: 10 } });
    const send = vi.spyOn(WhatsAppAdapter.prototype, 'send').mockResolvedValue('wamid.sent');
    const conversation = await customer();
    const job = await menuReply(conversation);
    await processJob(repo, job.id);
    expect(String(send.mock.calls[0]![1])).toContain('#t=');
    await handleTurn(repo, (await repo.getCompany(company.id))!, conversation, {
      messageId: randomUUID(),
      text: 'and the karahi?',
      now: new Date().toISOString(),
    });
    expect(generate).toHaveBeenCalledTimes(2);
    const prompt = String(generate.mock.calls[1]![0].prompt);
    expect(prompt).toContain('/m/dastarkhwan');
    expect(prompt).not.toContain('#t=');
  });
});

describe('personal link session', () => {
  beforeEach(async () => {
    await turnOn();
    await meta();
  });

  it('is ready with a masked number and the customer’s name', async () => {
    const conversation = await customer('923001234567', { customerName: 'Sana' });
    expect(await session(tokenFor(conversation))).toEqual({
      state: 'ready',
      phoneMasked: '+92 ••• 4567',
      name: 'Sana',
      whatsappUrl: 'https://wa.me/923001112233',
    });
  });

  it('works for linked-phone chats, including privacy IDs, until the connection changes', async () => {
    const connection = await linkedPhone();
    const address = {
      connectionId: connection.id,
      generation: 1,
      provider: 'baileys' as const,
      peer: '100000001@lid',
    };
    const privacy = await customer('', { whatsappAddress: address });
    const token = tokenFor(privacy);
    expect(await session(token)).toEqual({
      state: 'ready',
      whatsappUrl: 'https://wa.me/923009990000',
    });
    await repo.saveWhatsAppConnection({ ...connection, revision: 2, generation: 2 }, 1);
    expect((await session(token)).state).toBe('stale');
  });

  it('is stale for an old chat after the business connects a phone', async () => {
    const conversation = await customer();
    const token = tokenFor(conversation);
    await linkedPhone();
    expect((await session(token)).state).toBe('stale');
  });

  it('expires, and refuses another business’s link or a changed token', async () => {
    const conversation = await customer();
    expect(
      (await session(tokenFor(conversation, new Date(Date.now() - 3 * 3600000).toISOString())))
        .state,
    ).toBe('expired');
    await repo.saveCompany({ ...other, slug: 'bun-and-co' });
    await repo.setMenuLink(other.id, true, 'bun-and-co');
    expect((await session(tokenFor(conversation), 'bun-and-co')).state).toBe('invalid');
    expect((await session('x'.repeat(87))).state).toBe('invalid');
    expect((await session(tokenFor({ ...conversation, id: randomUUID() }))).state).toBe('invalid');
    const res = await call('/public/menu/dastarkhwan/session', { body: { token: 1 } });
    expect(await res.json()).toEqual({ state: 'invalid' });
  });

  it('says when staff, a paused bot, closing time or the reply window stop ordering', async () => {
    const conversation = await customer();
    const token = tokenFor(conversation);
    await update(conversation, { mode: 'human' });
    expect((await session(token)).state).toBe('staff');
    await update(conversation, { mode: 'bot' });
    await repo.saveCompany({ ...company, botEnabled: false });
    expect((await session(token)).state).toBe('bot_off');
    await repo.saveCompany({
      ...company,
      openingHours: { start: '09:00', end: '10:00', days: [] },
    });
    expect((await session(token)).state).toBe('closed');
    await repo.saveCompany(company);
    await update(conversation, {
      lastInboundAt: new Date(Date.now() - (23 * 60 + 56) * 60000).toISOString(),
    });
    expect((await session(token)).state).toBe('expired');
  });

  it('reports a blocked number without counting it as an ignored message', async () => {
    const conversation = await customer('923001234567');
    const token = tokenFor(conversation);
    await repo.blockCustomer(
      company.id,
      conversation.id,
      'block-1',
      ['pn:923001234567'],
      'Spam',
      'owner',
    );
    expect((await session(token)).state).toBe('blocked');
    // The number stays blocked even if this chat's own mark is gone.
    await update(conversation, { blocked: undefined });
    const hit = vi.spyOn(repo, 'findBlockedCustomer');
    expect((await session(token)).state).toBe('blocked');
    expect(hit).not.toHaveBeenCalled();
    expect((await repo.listBlockedCustomers(company.id))[0]!.blockedCount).toBe(0);
  });
});

describe('one-tap order from a personal link', () => {
  beforeEach(async () => {
    await turnOn();
    await meta();
  });
  const orders = async () =>
    (await repo.listOrders(company.id)).filter((o) => o.source === 'menu_page');

  it('places one pending order in the customer’s chat and confirms it there', async () => {
    const conversation = await customer();
    const token = tokenFor(conversation);
    const res = await order(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    const [saved] = await orders();
    expect(body).toEqual({
      reference: saved!.reference,
      total: 90000,
      alreadyPlaced: false,
      whatsappUrl: 'https://wa.me/923001112233',
    });
    expect(saved).toMatchObject({
      status: 'pending',
      sandbox: false,
      source: 'menu_page',
      conversationId: conversation.id,
      customerName: 'Ali',
    });
    const chat = (await repo.getConversation(company.id, conversation.id))!;
    expect(chat.lastInboundAt).toBe(conversation.lastInboundAt);
    expect(chat.messages.map((m) => m.id)).toEqual([`menu-order:${saved!.id}`]);
    expect(chat.cart).toMatchObject({ status: 'submitted', orderId: saved!.id });
    const sends = (await repo.listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toMatchObject({ source: 'notice', conversationId: conversation.id });
    expect(String(sends[0]!.payload.text)).toContain('Awaiting restaurant acceptance');
    expect(sends[0]!.payload.orderId).toBeUndefined();
    expect((await repo.listTraces(company.id)).map((t) => t.action)).toContain('menu_link_order');

    const again = await order(token);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      reference: saved!.reference,
      alreadyPlaced: true,
    });
    expect(await orders()).toHaveLength(1);
  });

  it('places exactly one order when tapped twice at once', async () => {
    const token = tokenFor(await customer());
    const results = await Promise.all([order(token), order(token)]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(await orders()).toHaveLength(1);
    const codes = results.map((r, i) =>
      r.status === 200 ? (bodies[i].alreadyPlaced ? 'again' : 'placed') : bodies[i].code,
    );
    expect(codes).toContain('placed');
    expect(codes.filter((c) => c === 'placed')).toHaveLength(1);
    expect(codes.every((c) => ['placed', 'again', 'busy'].includes(c))).toBe(true);
  });

  it('refuses a changed total with the new one, and keeps the link usable', async () => {
    const conversation = await customer();
    const token = tokenFor(conversation);
    const res = await order(token, { expectedTotal: 80000 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'price_changed', total: 90000 });
    expect(await orders()).toHaveLength(0);
    expect((await session(token)).state).toBe('ready');
    expect((await order(token)).status).toBe(200);
  });

  it('refuses while the bot is off, after hours, during staff chats and for blocked numbers', async () => {
    const conversation = await customer('923001234567');
    const token = tokenFor(conversation);
    await repo.saveCompany({ ...company, botEnabled: false });
    const off = await order(token);
    expect([off.status, (await off.json()).code]).toEqual([409, 'bot_off']);
    await repo.saveCompany({
      ...company,
      openingHours: { start: '09:00', end: '10:00', days: [] },
    });
    const closed = await order(token);
    expect([closed.status, (await closed.json()).code]).toEqual([409, 'closed']);
    await repo.saveCompany(company);
    await update(conversation, { mode: 'human' });
    const staff = await order(token);
    expect([staff.status, (await staff.json()).code]).toEqual([409, 'staff']);
    await update(conversation, { mode: 'bot' });
    await repo.blockCustomer(company.id, conversation.id, 'b', ['pn:923001234567'], 'x', 'o');
    const blocked = await order(token);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      code: 'blocked',
      error: 'Ordering isn’t available for this chat.',
    });
    expect(await orders()).toHaveLength(0);
    expect(
      await repo.findMenuLinkUse(
        company.id,
        (verifyMenuToken(company.id, token) as { claims: { nonce: string } }).claims.nonce,
      ),
    ).toBeUndefined();
  });

  it('refreshes a stale Google Sheets menu once before ordering', async () => {
    await repo.saveCompany({
      ...company,
      catalogSource: 'sheets',
      catalogSyncedAt: new Date(Date.now() - 5 * 60000).toISOString(),
    });
    await repo.saveIntegration(
      company.id,
      { kind: 'sheets', configured: true, status: 'connected', config: { spreadsheetId: 'x' } },
      encryptSecret('key'),
    );
    const read = vi
      .spyOn(GoogleSheetsAdapter.prototype, 'readCatalog')
      .mockResolvedValue(seedProducts.filter((p) => p.companyId === company.id));
    const res = await order(tokenFor(await customer()));
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledOnce();
    const [saved] = await orders();
    expect(saved!.syncStatus).toBe('pending');
    expect((await repo.listCompanyJobs(company.id)).map((j) => j.kind).sort()).toEqual([
      'sheet_sync',
      'whatsapp_send',
    ]);
  });

  it('turns away a bad cart with a friendly sentence', async () => {
    const token = tokenFor(await customer());
    const short = await order(token, { cart: { ...cart, customerName: 'A' } });
    expect(short.status).toBe(422);
    expect(await short.json()).toEqual({
      error: 'Please give a name between 2 and 80 characters.',
      code: 'invalid',
    });
    const extra = await order(token, { cart: { ...cart, price: 1 } });
    expect(extra.status).toBe(422);
    const expired = await order(
      tokenFor(await customer('923001239999'), new Date(Date.now() - 3 * 3600000).toISOString()),
    );
    expect([expired.status, (await expired.json()).code]).toEqual([410, 'expired']);
  });

  it('keeps chat buttons and cancelling safe after a page order', async () => {
    const conversation = await customer();
    const before = conversation.cart.revision;
    expect((await order(tokenFor(conversation))).status).toBe(200);
    const [placed] = await orders();
    const current = (await repo.getConversation(company.id, conversation.id))!;
    const tap = await handleTurn(repo, company, current, {
      messageId: 'old-confirm',
      text: 'Confirm order',
      action: { type: 'confirm', revision: before },
      now: new Date().toISOString(),
    });
    expect(tap.reply).toContain('already been submitted');
    expect(await orders()).toHaveLength(1);
    const cancel = await handleTurn(
      repo,
      company,
      (await repo.getConversation(company.id, conversation.id))!,
      { messageId: 'cancel-1', text: 'cancel', now: new Date().toISOString() },
    );
    expect(cancel.reply).toBe(`Order ${placed!.reference} has been cancelled.`);
    expect((await repo.getOrder(company.id, placed!.id))!.status).toBe('cancelled');
  });
});

// ── Instagram and QR orders ─────────────────────────────────────────────────────────────────

const CODE = /^OM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
async function draftFor(
  phone = '0300 1234567',
  body: Record<string, unknown> = {},
  slug = 'dastarkhwan',
) {
  const res = await call(`/public/menu/${slug}/drafts`, {
    body: { phone, cart, expectedTotal: 90000, ...body },
  });
  return { status: res.status, data: await res.json() };
}
const pageOrders = async () =>
  (await repo.listOrders(company.id)).filter((o) => o.source === 'menu_page');
const draftFrom = (ip: string, phone: string) =>
  createEdgeApp(repo).request(`${base}/public/menu/dastarkhwan/drafts`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ phone, cart, expectedTotal: 90000 }),
  });
/** 40 different dishes, each line about nameLength characters long in the confirmation. */
async function bigOrder(nameLength: number) {
  const dishes = Array.from({ length: 40 }, (_, i) => ({
    ...biryani,
    id: randomUUID(),
    name: `Dish ${i} ${'x'.repeat(nameLength)}`,
  }));
  for (const dish of dishes) await repo.saveProduct(dish);
  const items = dishes.map((d) => ({ productId: d.id, quantity: 1, modifierIds: [], notes: '' }));
  return { dishes, body: { cart: { ...cart, items }, expectedTotal: 40 * biryani.price } };
}
const TOO_LARGE = 'This order is too large for one message. Please order in WhatsApp instead.';

describe('typed WhatsApp numbers', () => {
  it('reads every usual form of a Pakistani mobile, and leaves foreign numbers alone', () => {
    for (const typed of [
      '0300 1234567',
      '+92 300 1234567',
      '300 1234567',
      '3001234567',
      '+92 0300 1234567',
      '0092 0300 1234567',
      '0300-1234567',
      '00923001234567',
      '923001234567',
    ])
      expect(normalizeTypedPhone(typed), typed).toBe('923001234567');
    expect(normalizeTypedPhone('+44 7700 900123')).toBe('447700900123');
    expect(normalizeTypedPhone('0044 7700 900123')).toBe('447700900123');
    expect(normalizeTypedPhone('+1 415 555 0123')).toBe('14155550123');
    for (const bad of ['', '12345', '0300 123456', '0300 12345678'])
      expect(normalizeTypedPhone(bad), bad).toBeUndefined();
  });
});

describe('order codes for Instagram and QR customers', () => {
  beforeEach(async () => {
    await turnOn();
    await meta();
  });

  it('gives a code and a WhatsApp link, and saves nothing else', async () => {
    const before = JSON.stringify([
      await repo.listConversations(company.id),
      await repo.listOrders(company.id),
      await repo.listCompanyJobs(company.id),
    ]);
    const { status, data } = await draftFor();
    expect(status).toBe(200);
    expect(data.code).toMatch(CODE);
    expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(29 * 60000);
    expect(data.whatsappUrl).toBe(
      `https://wa.me/923001112233?text=${encodeURIComponent(
        `Hi! Please place my menu order. Code: ${data.code}`,
      )}`,
    );
    expect(
      JSON.stringify([
        await repo.listConversations(company.id),
        await repo.listOrders(company.id),
        await repo.listCompanyJobs(company.id),
      ]),
    ).toBe(before);
  });

  it('never checks the typed number against blocked numbers', async () => {
    const chat = await customer('923001234567');
    await repo.blockCustomer(company.id, chat.id, 'b', ['pn:923001234567'], 'Spam', 'owner');
    const hit = vi.spyOn(repo, 'findBlockedCustomer');
    const lookup = vi.spyOn(repo, 'hasBlockedKey');
    expect((await draftFor()).status).toBe(200);
    expect(hit).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('limits codes per number and keeps no number or address in rate-limit keys', async () => {
    const consume = vi.spyOn(repo, 'consumeRateLimit');
    const send = () =>
      createEdgeApp(repo).request(`${base}/public/menu/dastarkhwan/drafts`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.9',
        },
        body: JSON.stringify({ phone: '+92 300 1234567', cart, expectedTotal: 90000 }),
      });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);
    const fourth = await send();
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ code: 'rate' });
    const keys = consume.mock.calls.map(([key]) => key);
    expect(keys.some((k) => k.startsWith('menu:draft:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('menu:draft-phone:'))).toBe(true);
    // No business-wide budget that a few addresses could use up.
    expect(keys.some((k) => k.startsWith('menu:draft-co:'))).toBe(false);
    for (const key of keys) {
      expect(key).not.toContain('3001234567');
      expect(key).not.toContain('203.0.113.9');
    }
    // Another number is not held up.
    expect((await draftFor('0300 7654321')).status).toBe(200);
  });

  it('refuses without a known WhatsApp number, a bad number or a changed price', async () => {
    await repo.disconnectIntegration(company.id, 'whatsapp');
    await repo.saveCompany(company);
    expect((await draftFor()).data).toMatchObject({ code: 'no_whatsapp' });
    await meta();
    expect(await draftFor('12345')).toEqual({
      status: 422,
      data: {
        error: 'Please enter your WhatsApp number, for example 0300 1234567.',
        code: 'invalid',
      },
    });
    expect(await draftFor('0300 1234567', { expectedTotal: 1 })).toMatchObject({
      status: 409,
      data: { code: 'price_changed', total: 90000 },
    });
  });

  it('lets no single address use up the restaurant’s codes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Bad requests from many addresses spend no budget shared with real customers.
    for (let i = 0; i < 70; i++)
      expect((await draftFrom(`198.51.100.${i}`, '12345')).status).toBe(422);
    expect((await draftFor()).status).toBe(200);
    // One address holds at most 15 codes waiting for WhatsApp; others are not held up.
    for (let i = 0; i < 15; i++)
      expect(
        (await draftFrom('203.0.113.9', `0300 00000${String(i).padStart(2, '0')}`)).status,
      ).toBe(200);
    const busy = await draftFrom('203.0.113.9', '0300 0000099');
    expect([busy.status, await busy.json()]).toEqual([
      429,
      {
        error:
          'Too many orders from this connection are waiting to be confirmed. Please try again later, or order in WhatsApp.',
        code: 'busy',
      },
    ]);
    expect((await draftFrom('203.0.113.10', '0300 0000099')).status).toBe(200);
  });

  it('gives no code for an order too large to confirm in one message', async () => {
    const { body } = await bigOrder(90);
    const create = vi.spyOn(repo, 'createMenuDraft');
    expect(await draftFor('0300 1234567', body)).toEqual({
      status: 422,
      data: { error: TOO_LARGE, code: 'too_large' },
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('order code sent from WhatsApp', () => {
  let reserve: MockInstance;
  beforeEach(async () => {
    await turnOn();
    await meta();
    vi.stubEnv('MODEL_PRICING_JSON', '');
    await repo.saveCompany({
      ...company,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    });
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-anthropic-key'),
    );
    generate.mockReset();
    generate.mockResolvedValue({
      output: {
        actions: [{ type: 'answer', text: '' }],
        response: { text: 'Hello!', askFor: 'none' },
      },
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    reserve = vi.spyOn(repo, 'reserveAiCall');
  });
  async function incoming(
    text: string,
    phone = '923001234567',
    extra: Record<string, unknown> = {},
  ) {
    const job = makeJob(company.id, 'incoming', {
      phone,
      messageId: `wamid.${randomUUID()}`,
      text,
      ...extra,
    });
    await repo.insertJob(job);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))?.status).toBe('done');
    return job;
  }
  const chatOf = async (phone = '923001234567') =>
    (await repo.findConversation(company.id, phone, 'whatsapp'))!;
  const lastReply = async (phone?: string) => (await chatOf(phone)).messages.at(-1)!;
  const message = (code: string) => `Hi! Please place my menu order. Code: ${code}`;

  it('places the order in the sender’s chat without any AI, once', async () => {
    const { data } = await draftFor();
    await incoming(message(data.code));
    const [placed] = await pageOrders();
    expect(placed).toMatchObject({ status: 'pending', sandbox: false, source: 'menu_page' });
    const chat = await chatOf();
    expect(chat.id).toBe(placed!.conversationId);
    expect(chat.messages.map((m) => m.role)).toEqual(['customer', 'assistant']);
    expect(chat.messages[1]!.text).toContain(`Order ${placed!.reference} received`);
    expect(chat.messages[1]!.explanation).toMatchObject({
      ai: { called: false, skipped: 'menu_page' },
      outcome: 'order',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    const sends = (await repo.listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(sends.map((j) => j.payload.source)).toEqual(['notice']);

    await incoming(`  om-${data.code.slice(3).toLowerCase()} please`);
    expect((await lastReply()).text).toBe(
      `Your order ${placed!.reference} is already with the restaurant.`,
    );
    expect(await pageOrders()).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it('answers an unknown, expired or other business’s code without ordering', async () => {
    const expired =
      'This order code has expired or was already used. Please open the menu link again to place your order.';
    await incoming(message('OM-AAAA-AAAA'));
    expect((await lastReply()).text).toBe(expired);
    await repo.saveCompany({ ...other, slug: 'bun-and-co' });
    await repo.setMenuLink(other.id, true, 'bun-and-co');
    await repo.saveIntegration(
      other.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'connected',
        config: { phoneNumberId: '456', displayPhoneNumber: '923004445555' },
      },
      encryptSecret('other-token'),
    );
    const theirs = await call('/public/menu/bun-and-co/drafts', {
      body: {
        phone: '0300 1234567',
        cart: {
          ...cart,
          items: [
            {
              productId: seedProducts.find((p) => p.companyId === other.id && !p.variants.length)!
                .id,
              quantity: 1,
              modifierIds: [],
              notes: '',
            },
          ],
        },
        expectedTotal: seedProducts.find((p) => p.companyId === other.id && !p.variants.length)!
          .price,
      },
    });
    expect(theirs.status).toBe(200);
    await incoming(message((await theirs.json()).code));
    expect((await lastReply()).text).toBe(expired);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { data } = await draftFor();
    vi.setSystemTime(Date.now() + 31 * 60000);
    await incoming(message(data.code));
    expect((await lastReply()).text).toBe(expired);
    expect(await pageOrders()).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('refuses a code made for another number, but accepts a privacy ID chat', async () => {
    const { data } = await draftFor('0300 7654321');
    await incoming(message(data.code));
    expect((await lastReply()).text).toBe(
      'This order code was made for a different number. Please open the menu link on this phone.',
    );
    expect(await pageOrders()).toHaveLength(0);
    const connection = await linkedPhone();
    const address = {
      connectionId: connection.id,
      generation: 1,
      provider: 'baileys' as const,
      peer: '100000001@lid',
    };
    const privacy = await draftFor('0300 7654321');
    await incoming(message(privacy.data.code), '', {
      whatsappAddress: address,
      streamKey: `${connection.id}:1:${address.peer}`,
    });
    const [placed] = await pageOrders();
    const chat = (await repo.findWhatsAppConversation(company.id, address))!;
    expect(placed!.conversationId).toBe(chat.id);
  });

  it('resumes a chat paused by an AI limit to place the order', async () => {
    const at = new Date().toISOString();
    await customer('923001234567', {
      mode: 'human',
      limitPause: {
        reason: 'customer',
        at,
        until: new Date(Date.now() + 3600000).toISOString(),
        limit: 1000,
      },
    });
    const { data } = await draftFor();
    await incoming(message(data.code));
    expect(await pageOrders()).toHaveLength(1);
    expect((await chatOf()).mode).toBe('bot');
    expect(generate).not.toHaveBeenCalled();
  });

  it('leaves the code unused for staff chats and while the bot is off', async () => {
    const { data } = await draftFor();
    await customer('923001234567', { mode: 'human' });
    await incoming(message(data.code));
    expect((await lastReply()).role).toBe('customer');
    expect(await pageOrders()).toHaveLength(0);
    const { data: second } = await draftFor('0300 7654321');
    await repo.saveCompany({ ...(await repo.getCompany(company.id))!, botEnabled: false });
    await incoming(message(second.code), '923007654321');
    expect((await lastReply('923007654321')).role).toBe('customer');
    expect(await pageOrders()).toHaveLength(0);
    // The code still works once the chat is back with the bot.
    await repo.saveCompany({ ...(await repo.getCompany(company.id))!, botEnabled: true });
    await incoming(message(second.code), '923007654321');
    expect(await pageOrders()).toHaveLength(1);
  });

  it('drops a blocked sender’s code before saving anything', async () => {
    const { data } = await draftFor();
    const chat = await customer('923001234567');
    await repo.blockCustomer(company.id, chat.id, 'b', ['pn:923001234567'], 'Spam', 'owner');
    await incoming(message(data.code));
    expect((await chatOf()).messages).toHaveLength(0);
    expect(await pageOrders()).toHaveLength(0);
  });

  it('places codes typed with any form of the sender’s own number', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const forms = [
      '300 1234567',
      '3001234567',
      '+92 0300 1234567',
      '0300-1234567',
      '00923001234567',
    ];
    for (const [i, typed] of forms.entries()) {
      const { status, data } = await draftFor(typed);
      expect(status, typed).toBe(200);
      await incoming(message(data.code));
      expect(await pageOrders(), typed).toHaveLength(i + 1);
      // Past the per-number limit of 3 codes a minute.
      vi.setSystemTime(Date.now() + 61000);
    }
    const { data } = await draftFor('+44 7700 900123');
    await incoming(message(data.code), '447700900123');
    expect(await pageOrders()).toHaveLength(forms.length + 1);
  });

  it('keeps only a number’s newest code', async () => {
    const { data: first } = await draftFor();
    const { data: second } = await draftFor('+92 300 1234567');
    await incoming(message(first.code));
    expect((await lastReply()).text).toBe(
      'This order code has expired or was already used. Please open the menu link again to place your order.',
    );
    await incoming(message(second.code));
    expect(await pageOrders()).toHaveLength(1);
  });

  it('asks for an order too large for one message in the chat instead', async () => {
    const { dishes, body } = await bigOrder(30);
    const { status, data } = await draftFor('0300 1234567', body);
    expect(status).toBe(200);
    // Longer dish names since the code was made: the confirmation no longer fits.
    for (const dish of dishes)
      await repo.saveProduct({ ...dish, name: `${dish.name} ${'y'.repeat(70)}` });
    await incoming(message(data.code));
    expect((await lastReply()).text).toBe(
      'This order is too large for one message. Please tell us your order here.',
    );
    expect(await pageOrders()).toHaveLength(0);
  });

  it('says when prices changed since the code was made', async () => {
    const { data } = await draftFor();
    await repo.saveProduct({ ...biryani, price: 46000 });
    await incoming(message(data.code));
    expect((await lastReply()).text).toBe(
      'Prices or items changed since you made this order. Please open the menu link again.',
    );
    expect(await pageOrders()).toHaveLength(0);
  });

  it('ignores look-alike words, and codes for a business without a menu page', async () => {
    const find = vi.spyOn(repo, 'findMenuDraft');
    for (const text of ['omelettes2', 'OMGGGGGGGG', 'om abcd efgh', 'OM-ABCD-EFGI'])
      await incoming(text);
    expect(find).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(4);
    const job = makeJob(other.id, 'incoming', {
      phone: '923001234567',
      messageId: 'wamid.other',
      text: message('OM-ABCD-EFGH'),
    });
    await repo.insertJob(job);
    await processJob(repo, job.id);
    expect(find).not.toHaveBeenCalled();
  });
});
