// Deals through the API and the stores: owner-only routes that a Sheets menu does not block,
// link checks only for links an owner adds or changes, one id space for menu items and deals,
// a database without the deals migration, and deals sold from the menu page at their own times.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SupabaseRepository } from '../server/repository';
import { handleTurn } from '../server/service';
import { publicMenu } from '../server/menu';
import { signMenuToken } from '../server/menu-token';
import { encryptSecret } from '../server/security';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Bootstrap, Conversation, Deal } from '../src/shared/types';
import type { PublicMenu } from '../src/shared/menu';
import { company, demoApp } from './helpers/demo-app';

// Live-mode sign-in for the owner-only checks: the bearer token is the user id. Any other client
// (the Supabase store below) stays real, with fetch stubbed.
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  const createClient = (url: string, key: string, options?: object) =>
    key === 'test-anon-key'
      ? {
          auth: {
            getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }),
          },
        }
      : actual.createClient(url, key, options);
  return { ...actual, createClient };
});

const app = demoApp();
const other = seedCompanies[1]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const karahi = products.find((p) => p.name === 'Chicken Karahi')!;
const drink = {
  id: 'drink',
  name: 'Drink',
  options: [
    { id: 'drink-coke', name: 'Coke', price: 0 },
    { id: 'drink-fanta', name: 'Fanta', price: 5000 },
  ],
};
// What the Deals editor sends.
const body = (fields: Record<string, unknown> = {}) => ({
  name: 'Zinger Combo',
  price: 79900,
  regularPrice: 104900,
  items: [
    { name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
    { name: 'Drink', quantity: 1 },
  ],
  choices: [drink],
  available: true,
  ...fields,
});
// A deal already saved, as the store keeps it.
const stored = (fields: Partial<Deal> = {}): Deal => ({
  id: randomUUID(),
  companyId: company.id,
  name: 'Family Combo',
  description: '',
  emoji: '🎁',
  aliases: [],
  price: 150000,
  items: [{ name: 'Chicken Karahi', quantity: 1 }],
  choices: [],
  available: true,
  position: 1,
  updatedAt: new Date().toISOString(),
  ...fields,
});
async function call(path: string, init: { body?: unknown; method?: string; user?: string } = {}) {
  const res = await app.request(path, {
    body: init.body,
    method: init.method,
    headers: init.user ? { Authorization: `Bearer ${init.user}` } : {},
  });
  return { status: res.status, data: await res.json() };
}
const saveDeal = (fields: Record<string, unknown> = {}) => call('/deals', { body: body(fields) });
const deals = () => app.repo().listDeals(company.id);

describe('the deals routes', () => {
  it('creates, edits, lists and deletes a deal, placing a new one last', async () => {
    const first = await saveDeal();
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      companyId: company.id,
      name: 'Zinger Combo',
      description: '',
      emoji: '🎁',
      aliases: [],
      price: 79900,
      regularPrice: 104900,
      choices: [drink],
      available: true,
      position: 1,
      updatedAt: expect.any(String),
    });
    expect(first.data).not.toHaveProperty('schedule');
    const second = await saveDeal({ name: 'Family Combo' });
    expect(second.data.position).toBe(2);
    const edited = await saveDeal({ id: first.data.id, name: 'Zinger Lunch Combo' });
    expect(edited.data).toMatchObject({
      id: first.data.id,
      name: 'Zinger Lunch Combo',
      position: 1,
    });
    expect((await deals()).map((d) => d.name).sort()).toEqual([
      'Family Combo',
      'Zinger Lunch Combo',
    ]);
    const boot = (await call('/bootstrap')).data as Bootstrap;
    expect(boot.deals?.map((d) => d.id).sort()).toEqual([first.data.id, second.data.id].sort());
    // An id must be one of the business's deals, never a menu item's.
    for (const id of [randomUUID(), biryani.id])
      expect(await saveDeal({ id })).toEqual({ status: 404, data: { error: 'Deal not found.' } });
    expect(await call(`/deals/${second.data.id}`, { method: 'DELETE' })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await deals()).map((d) => d.id)).toEqual([first.data.id]);
  });

  it('refuses a deal the editor should never send', async () => {
    const refused: [Record<string, unknown>, string][] = [
      [{ price: -1 }, 'price'],
      [{ name: ' ' }, 'name'],
      [{ items: [] }, 'Add what the deal includes.'],
      [{ items: [{ name: 'Fries', quantity: 1, variantId: 'large' }] }, 'A size needs a linked'],
      // Said in the editor's words, not as the field path "items.0.quantity".
      [
        { items: [{ name: 'Fries', quantity: 51 }] },
        'Give each included item a number from 1 to 50.',
      ],
      [
        { choices: [{ ...drink, options: [drink.options[0]] }] },
        'Give each choice at least 2 options.',
      ],
      [{ choices: [drink, { ...drink, name: 'Side' }] }, 'Choice IDs must be unique.'],
      [
        {
          choices: [
            drink,
            {
              id: 'drink-2',
              name: 'drink',
              options: [
                { id: 'a', name: 'Coke', price: 0 },
                { id: 'b', name: 'Sprite', price: 0 },
              ],
            },
          ],
        },
        'Give each choice its own name.',
      ],
      [
        {
          choices: [
            {
              ...drink,
              options: [...drink.options, { id: 'drink-coke-2', name: 'coke', price: 0 }],
            },
          ],
        },
        'Option names must be unique within a choice.',
      ],
      [{ choices: Array.from({ length: 6 }, (_, i) => ({ ...drink, id: `g${i}` })) }, 'choices'],
      [{ imageUrl: 'http://cdn.example/combo.jpg' }, 'https://'],
      [{ schedule: { days: [1, 1], start: '12:00', end: '15:00' } }, 'Choose each day only once.'],
      [{ schedule: { days: [], start: '12:00', end: '15:00' } }, 'Choose at least one day.'],
      [
        { schedule: { days: [1], start: '24:00', end: '15:00' } },
        'Enter the time the deal starts and the time it ends.',
      ],
      [
        { schedule: { days: [1], start: '12:00', end: '15:00', startDate: '2026-02-30' } },
        'Use a real date.',
      ],
      [
        {
          schedule: {
            days: [1],
            start: '12:00',
            end: '15:00',
            startDate: '2026-10-21',
            endDate: '2026-10-20',
          },
        },
        'The end date is before the start date.',
      ],
      // Tuesday 20 and Wednesday 21 October 2026, on Fridays only.
      [
        {
          schedule: {
            days: [5],
            start: '12:00',
            end: '15:00',
            startDate: '2026-10-20',
            endDate: '2026-10-21',
          },
        },
        'None of the chosen days falls between the start and end dates.',
      ],
    ];
    for (const [fields, message] of refused) {
      const res = await saveDeal(fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.data.error, JSON.stringify(fields)).toContain(message);
      // The owner reads it in the Deals dialog: never a field path or the validator's wording.
      expect(res.data.error, JSON.stringify(fields)).not.toMatch(
        /\w\.\d|^\w+: |Too (big|small)|expected|Invalid/,
      );
    }
    expect(await deals()).toEqual([]);
  });

  it('says what an older Deals tab sent wrong in plain words', async () => {
    const refused: [Record<string, unknown>, string][] = [
      [
        { aliases: Array.from({ length: 11 }, (_, i) => `name ${i}`) },
        'Use at most 10 other names.',
      ],
      [{ aliases: ['x'.repeat(61)] }, 'Keep each other name to 60 characters or fewer.'],
      [{ price: 100_000_001 }, 'Enter a deal price up to Rs. 1,000,000.'],
      [{ regularPrice: -1 }, 'Enter a price if bought separately up to Rs. 1,000,000'],
      [
        {
          choices: [{ ...drink, options: [...drink.options, { id: 'x', name: 'y'.repeat(101) }] }],
        },
        'Name each option in up to 100 characters.',
      ],
      [{ name: 'x'.repeat(121) }, 'Give the deal a name of up to 120 characters.'],
      [{ available: 'yes' }, 'Reload the page and try again.'],
    ];
    for (const [fields, message] of refused)
      expect(await saveDeal(fields), JSON.stringify(fields)).toEqual({
        status: 400,
        data: { error: expect.stringContaining(message) },
      });
    expect(await deals()).toEqual([]);
  });

  it('tidies what the editor sends: an always-on schedule is no schedule', async () => {
    const always = await saveDeal({
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00', startDate: '' },
    });
    expect(always.status).toBe(200);
    expect(always.data).not.toHaveProperty('schedule');
    const lunch = await saveDeal({
      aliases: [' ', 'zinger meal'],
      regularPrice: null,
      imageUrl: '',
      schedule: { days: [5, 1, 3], start: '12:00', end: '15:00', endDate: '2026-12-31' },
    });
    expect(lunch.data).toMatchObject({
      aliases: ['zinger meal'],
      schedule: { days: [1, 3, 5], start: '12:00', end: '15:00', endDate: '2026-12-31' },
    });
    expect(lunch.data).not.toHaveProperty('regularPrice');
    expect(lunch.data).not.toHaveProperty('imageUrl');
    expect(lunch.data.schedule).not.toHaveProperty('startDate');
  });

  it('lets only an owner change deals, while staff still read them', async () => {
    const repo = app.repo();
    const deal = stored();
    await repo.saveDeal(deal);
    vi.stubEnv('APP_MODE', 'live');
    vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon-key');
    vi.spyOn(repo, 'listAllowedCompanies').mockResolvedValue([company]);
    const role = vi.spyOn(repo, 'getRole').mockResolvedValue('staff');
    const changes: [string, string, unknown?][] = [
      ['POST', '/deals', body()],
      ['POST', `/deals/${deal.id}/available`, { available: false }],
      ['POST', '/deals/order', { ids: [deal.id] }],
      ['DELETE', `/deals/${deal.id}`],
    ];
    for (const [method, path, payload] of changes)
      expect(await call(path, { method, body: payload, user: 'staff-user' }), path).toEqual({
        status: 403,
        data: { error: 'Only the restaurant owner can change these settings.' },
      });
    expect(await deals()).toEqual([deal]);
    const boot = await call('/bootstrap', { user: 'staff-user' });
    expect(boot.status).toBe(200);
    expect((boot.data as Bootstrap).deals).toEqual([deal]);
    role.mockResolvedValue('owner');
    expect((await call('/deals', { body: body(), user: 'owner-user' })).status).toBe(200);
  });

  it('works for a menu kept in Google Sheets', async () => {
    await app.repo().saveCompany({ ...company, catalogSource: 'sheets' });
    expect((await saveDeal()).status).toBe(200);
    // Menu items of a Sheets menu are edited in the Sheet.
    expect((await call('/products', { body: { ...biryani, id: undefined } })).status).toBe(400);
  });

  it('keeps at most 50 deals, while those can still be edited', async () => {
    const repo = app.repo();
    const kept = Array.from({ length: 50 }, (_, i) => stored({ position: i + 1 }));
    for (const deal of kept) await repo.saveDeal(deal);
    const extra = await saveDeal();
    expect(extra).toEqual({
      status: 409,
      data: { error: 'You can have up to 50 deals. Delete one you no longer use first.' },
    });
    expect((await saveDeal({ id: kept[0]!.id })).status).toBe(200);
    expect(await deals()).toHaveLength(50);
  });

  it('keeps the limit when two new deals are saved at once, and reorders however many there are', async () => {
    const repo = app.repo();
    for (let i = 0; i < 49; i++) await repo.saveDeal(stored({ position: i + 1 }));
    // Two phones save a new deal at the same moment: both see 49 before either is saved. One
    // or both are taken back (both only when each counts the other), never 51 kept.
    const both = await Promise.all([saveDeal(), saveDeal({ name: 'Family Combo' })]);
    for (const res of both)
      if (res.status !== 200)
        expect(res).toEqual({
          status: 409,
          data: { error: 'You can have up to 50 deals. Delete one you no longer use first.' },
        });
    expect(both.filter((res) => res.status === 200).length).toBeLessThanOrEqual(1);
    expect((await deals()).length).toBe(both.filter((res) => res.status === 200).length + 49);
    // A deal saved after the race still fits while there is room.
    if ((await deals()).length < 50) expect((await saveDeal()).status).toBe(200);
    expect(await deals()).toHaveLength(50);
    // Deals beyond 50 (put there by hand, say) never stop the owner saving a new order.
    for (let i = 0; i < 3; i++) await repo.saveDeal(stored({ position: 60 + i }));
    const all = await deals();
    expect(all.length).toBeGreaterThan(50);
    const ids = all.map((d) => d.id).reverse();
    expect(await call('/deals/order', { body: { ids } })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const positions = Object.fromEntries((await deals()).map((d) => [d.id, d.position]));
    expect(ids.map((id) => positions[id])).toEqual(ids.map((_, i) => i + 1));
  });

  it('checks only the menu links added or changed now', async () => {
    const gone = { name: 'Zinger burger', quantity: 1, productId: randomUUID() };
    expect(await saveDeal({ items: [gone] })).toEqual({
      status: 422,
      data: { error: 'Zinger burger is no longer on your menu.' },
    });
    const size = (variantId: string) => ({
      name: 'Karahi',
      quantity: 1,
      productId: karahi.id,
      variantId,
    });
    expect(await saveDeal({ items: [size('no-such-size')] })).toEqual({
      status: 422,
      data: { error: 'Choose a size for Chicken Karahi.' },
    });
    expect((await saveDeal({ items: [size(karahi.variants[1]!.id)] })).status).toBe(200);
    // A link saved before, whose item has since left the menu, is kept while unchanged.
    const deal = stored({ items: [gone, { name: 'Drink', quantity: 1 }] });
    await app.repo().saveDeal(deal);
    const renamed = await saveDeal({ id: deal.id, name: 'Zinger Night Combo', items: deal.items });
    expect(renamed.status).toBe(200);
    expect(renamed.data.items[0]).toEqual(gone);
    expect(
      await saveDeal({ id: deal.id, items: [{ ...gone, variantId: 'large' }, deal.items[1]] }),
    ).toEqual({ status: 422, data: { error: 'Zinger burger is no longer on your menu.' } });
    expect(
      (await saveDeal({ id: deal.id, items: [{ name: 'Zinger burger', quantity: 1 }] })).status,
    ).toBe(200);
  });

  it('pauses and resumes a deal at once, without checking its links', async () => {
    const deal = stored({
      items: [{ name: 'Zinger burger', quantity: 1, productId: randomUUID() }],
    });
    await app.repo().saveDeal(deal);
    const paused = await call(`/deals/${deal.id}/available`, { body: { available: false } });
    expect(paused.status).toBe(200);
    expect(paused.data).toEqual({ ...deal, available: false, updatedAt: expect.any(String) });
    expect((await deals())[0]!.available).toBe(false);
    await call(`/deals/${deal.id}/available`, { body: { available: true } });
    expect((await deals())[0]!.available).toBe(true);
    expect(
      (await call(`/deals/${randomUUID()}/available`, { body: { available: true } })).status,
    ).toBe(404);
    for (const wrong of [{ available: 'no' }, { available: true, price: 1 }, {}])
      expect((await call(`/deals/${deal.id}/available`, { body: wrong })).status).toBe(400);
  });

  it('reorders deals in one request, putting any it leaves out after', async () => {
    const [a, b, c] = [1, 2, 3].map((position) => stored({ position }));
    for (const deal of [a!, b!, c!]) await app.repo().saveDeal(deal);
    expect(await call('/deals/order', { body: { ids: [c!.id, a!.id] } })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const positions = Object.fromEntries((await deals()).map((d) => [d.id, d.position]));
    expect(positions).toEqual({ [c!.id]: 1, [a!.id]: 2, [b!.id]: 3 });
    expect((await call('/deals/order', { body: { ids: [randomUUID()] } })).status).toBe(404);
    expect((await call('/deals/order', { body: { ids: [a!.id, a!.id] } })).status).toBe(400);
    expect((await call('/deals/order', { body: { ids: ['not-a-uuid'] } })).status).toBe(400);
  });
});

describe('one id space for menu items and deals in the local store', () => {
  const inUse = { status: 409, message: 'Menu item ID is already in use.' };
  it('refuses a deal with any business’s menu item id', async () => {
    const repo = app.repo();
    const theirs = seedProducts.find((p) => p.companyId === other.id)!;
    for (const id of [biryani.id, theirs.id])
      await expect(repo.saveDeal(stored({ id }))).rejects.toMatchObject(inUse);
    expect(await deals()).toEqual([]);
  });

  it('refuses a menu item with any business’s deal id, one by one, by import or by CSV', async () => {
    const repo = app.repo();
    const ours = stored();
    const theirs = stored({ companyId: other.id });
    await repo.saveDeal(ours);
    await repo.saveDeal(theirs);
    for (const deal of [ours, theirs]) {
      await expect(
        repo.saveProduct({ ...biryani, id: deal.id, companyId: company.id }),
      ).rejects.toMatchObject(inUse);
      await expect(
        repo.replaceProducts(company.id, [...products, { ...biryani, id: deal.id }]),
      ).rejects.toMatchObject(inUse);
    }
    const csv = `id,name,category,price,available\n${theirs.id},Tea,Drinks,50,true`;
    expect(await call('/catalog/import', { body: { csv } })).toEqual({
      status: 409,
      data: { error: 'Menu item ID is already in use.' },
    });
    expect(await repo.listProducts(company.id)).toEqual(products);
  });
});

describe('before the deals migration (Supabase)', () => {
  const missing = () =>
    vi
      .mocked(fetch)
      .mockImplementation(async () =>
        Response.json(
          { code: 'PGRST205', message: "Could not find the table 'public.deals'" },
          { status: 404 },
        ),
      );
  const supabase = () =>
    new SupabaseRepository('https://test.supabase.co', 'fake-service-role-key');

  it('has no deals, and asks for the migration before saving one', async () => {
    missing();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = supabase();
    expect(await repo.listDeals(company.id)).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('202610210001_deals.sql');
    const migrate = {
      status: 503,
      message: 'Apply the 202610210001_deals.sql database migration first.',
    };
    await expect(repo.saveDeal(stored())).rejects.toMatchObject(migrate);
    await expect(repo.deleteDeal(company.id, randomUUID())).rejects.toMatchObject(migrate);
    await expect(repo.setDealPositions(company.id, [randomUUID()])).rejects.toMatchObject(migrate);
    // Any other failure is still a failure.
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ code: 'XX000', message: 'boom' }, { status: 500 }),
    );
    await expect(repo.listDeals(company.id)).rejects.toThrow('Database operation failed');
  });

  it('says a taken id in the owner’s words', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ code: 'P0001', message: 'Menu item ID is already in use' }, { status: 400 }),
    );
    const repo = supabase();
    const inUse = { status: 409, message: 'Menu item ID is already in use.' };
    await expect(repo.saveDeal(stored())).rejects.toMatchObject(inUse);
    await expect(repo.saveProduct(biryani)).rejects.toMatchObject(inUse);
    await expect(repo.replaceProducts(company.id, products)).rejects.toMatchObject(inUse);
  });

  it('keeps the bot and the menu page working with no deals', async () => {
    missing();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = app.repo();
    const store = supabase();
    vi.spyOn(repo, 'listDeals').mockImplementation((id) => store.listDeals(id));
    await repo.setMenuLink(company.id, true, company.slug);
    const menu = await publicMenu(repo, company.slug, new Date().toISOString());
    expect(menu.categories.flatMap((c) => c.items.map((i) => i.id)).sort()).toEqual(
      products.map((p) => p.id).sort(),
    );
    const turn = await handleTurn(
      repo,
      company,
      createConversation(company.id, 'demo-deals', 'demo', new Date().toISOString()),
      {
        messageId: randomUUID(),
        text: '',
        action: { type: 'add_item', productId: biryani.id, quantity: 1 },
        now: new Date().toISOString(),
      },
    );
    expect(turn.reply).toContain('Chicken Biryani');
    expect(turn.conversation.cart.items).toHaveLength(1);
  });
});

describe('deals sold from the menu page', () => {
  const slug = company.slug;
  const lunch: Deal['schedule'] = { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' };
  async function openPage(deal: Deal) {
    const repo = app.repo();
    await repo.setMenuLink(company.id, true, slug);
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'connected',
        config: { phoneNumberId: '123', displayPhoneNumber: '923001112233' },
      },
      encryptSecret('meta-token'),
    );
    await repo.saveDeal(deal);
  }
  // A customer's chat and their personal link, issued now.
  async function linkFor(phone = '923001230000') {
    const conversation: Conversation = {
      ...createConversation(
        company.id,
        phone,
        'whatsapp',
        new Date(Date.now() - 10 * 60000).toISOString(),
      ),
      version: 1,
    };
    expect(await app.repo().saveConversation(conversation, 0)).toBe(true);
    return signMenuToken(
      company.id,
      { conversationId: conversation.id },
      { jobId: randomUUID(), issuedAt: new Date().toISOString() },
    )!;
  }
  const cartOf = (deal: Deal, modifierIds: string[], quantity = 2) => ({
    items: [{ productId: deal.id, quantity, modifierIds, notes: '' }],
    fulfillment: 'pickup',
    customerName: 'Ali',
  });
  const order = (token: string, cart: unknown, expectedTotal: number) =>
    call(`/public/menu/${slug}/orders`, { body: { token, cart, expectedTotal } });
  const pageOrders = async () =>
    (await app.repo().listOrders(company.id)).filter((o) => o.source === 'menu_page');

  it('places a deal with its pick from a personal link, as one line with the pick', async () => {
    const deal = stored({
      name: 'Zinger Combo',
      price: 79900,
      items: [
        { name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
        { name: 'Drink', quantity: 1 },
      ],
      choices: [drink],
    });
    await openPage(deal);
    const menu = (await call(`/public/menu/${slug}`)).data as PublicMenu;
    expect(menu.categories[0]).toMatchObject({ name: 'Deals', items: [{ id: deal.id }] });
    const token = await linkFor();
    expect(await order(token, cartOf(deal, []), 159800)).toEqual({
      status: 422,
      data: { code: 'invalid', error: 'Choose Drink for Zinger Combo: Coke, Fanta.' },
    });
    const placed = await order(token, cartOf(deal, ['drink-fanta']), 169800);
    expect(placed).toMatchObject({ status: 200, data: { total: 169800, alreadyPlaced: false } });
    const [saved] = await pageOrders();
    expect(saved).toMatchObject({ subtotal: 169800, total: 169800 });
    expect(saved!.items).toEqual([
      {
        productId: deal.id,
        name: 'Zinger Combo',
        quantity: 2,
        unitPrice: 84900,
        variant: 'Drink: Fanta',
        modifiers: [],
        notes: '',
        total: 169800,
        choices: [{ group: 'Drink', option: 'Fanta' }],
        includes: ['1 × Chicken Biryani', '1 × Drink'],
      },
    ]);
    const sends = (await app.repo().listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(String(sends[0]!.payload.text)).toContain('2 × Zinger Combo (Drink: Fanta)');
  });

  it('refuses the same order outside the deal’s times or while paused, as unavailable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Wednesday 21 October 2026, 11:55 in Karachi.
      vi.setSystemTime(new Date('2026-10-21T06:55:00.000Z'));
      const deal = stored({ name: 'Lunch Combo', price: 79900, choices: [drink], schedule: lunch });
      await openPage(deal);
      const token = await linkFor();
      const cart = cartOf(deal, ['drink-coke'], 1);
      expect(await order(token, cart, 79900)).toEqual({
        status: 422,
        data: {
          code: 'unavailable',
          error:
            'Lunch Combo is unavailable right now. It is on Mon–Fri 12:00–15:00. Remove it to continue.',
        },
      });
      vi.setSystemTime(new Date('2026-10-21T07:05:00.000Z'));
      await call(`/deals/${deal.id}/available`, { body: { available: false } });
      expect(await order(token, cart, 79900)).toEqual({
        status: 422,
        data: {
          code: 'unavailable',
          error: 'Lunch Combo is unavailable right now. Remove it to continue.',
        },
      });
      expect(await pageOrders()).toEqual([]);
      await call(`/deals/${deal.id}/available`, { body: { available: true } });
      expect(await order(token, cart, 79900)).toMatchObject({
        status: 200,
        data: { total: 79900 },
      });
      expect(await pageOrders()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an order code made in the deal’s times and sent after, naming the deal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Wednesday 12:20 in Karachi; the deal runs 12:00–12:30.
      vi.setSystemTime(new Date('2026-10-21T07:20:00.000Z'));
      const deal = stored({
        name: 'Lunch Combo',
        price: 79900,
        choices: [drink],
        schedule: { ...lunch!, end: '12:30' },
      });
      await openPage(deal);
      const draft = await call(`/public/menu/${slug}/drafts`, {
        body: {
          phone: '0300 1234567',
          cart: cartOf(deal, ['drink-coke'], 1),
          expectedTotal: 79900,
        },
      });
      expect(draft.status).toBe(200);
      vi.setSystemTime(new Date('2026-10-21T07:35:00.000Z'));
      const now = new Date().toISOString();
      const turn = await handleTurn(
        app.repo(),
        (await app.repo().getCompany(company.id))!,
        createConversation(company.id, '923001234567', 'whatsapp', now),
        {
          messageId: `wamid.${randomUUID()}`,
          text: `Hi! Please place my menu order. Code: ${draft.data.code}`,
          now,
        },
      );
      expect(turn.reply).toContain(
        "Lunch Combo is not available right now, so this order wasn't placed. Please open the menu link again.",
      );
      expect(turn.order).toBeUndefined();
      expect(await pageOrders()).toEqual([]);
      expect(
        (await app.repo().listTraces(company.id)).find((t) => t.action === 'menu_code_refused'),
      ).toMatchObject({ detail: 'Order code refused: deal not on.' });
    } finally {
      vi.useRealTimers();
    }
  });
});
