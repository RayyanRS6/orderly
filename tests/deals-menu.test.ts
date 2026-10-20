// Deals on the public menu page, from the server's side: what the page is told about each deal at
// the moment it asks, the page pricing a deal exactly as the server does, and order codes for a
// deal that stopped being on, refused in the chat's own language.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { publicMenu, redeemMenuDraft } from '../server/menu';
import { handleTurn } from '../server/service';
import { encryptSecret } from '../server/security';
import { createConversation } from '../src/domain/engine';
import { MenuOrderError, quoteWebCart } from '../src/domain/web-order';
import { addLine, previewQuote } from '../src/lib/menu-cart';
import { defaultBot } from '../src/shared/bot';
import { sellableCatalog } from '../src/shared/deals';
import { menuCodeIn, type PublicMenu } from '../src/shared/menu';
import { seedProducts } from '../src/shared/seed';
import type { CartItem, Conversation, Deal, Language } from '../src/shared/types';
import { company, demoApp } from './helpers/demo-app';

const app = demoApp();
const slug = company.slug;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const daal = products.find((p) => p.name === 'Daal Makhani')!;
const every = [0, 1, 2, 3, 4, 5, 6];
const lunch = { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' };
// Wednesday 21 October 2026 in Karachi: 12:05 and 15:00.
const noon = '2026-10-21T07:05:00.000Z';
const afternoon = '2026-10-21T10:00:00.000Z';
const drink = {
  id: 'drink',
  name: 'Drink',
  options: [
    { id: 'coke', name: 'Coke', price: 0 },
    { id: 'fanta', name: 'Fanta', price: 5000 },
  ],
};
const side = {
  id: 'side',
  name: 'Side',
  options: [
    { id: 'fries', name: 'Fries', price: 0 },
    { id: 'raita', name: 'Raita', price: 3000 },
  ],
};
const deal = (fields: Partial<Deal> = {}): Deal => ({
  id: randomUUID(),
  companyId: company.id,
  name: 'Lunch Combo',
  description: '',
  emoji: '🎁',
  aliases: [],
  price: 79900,
  items: [
    { name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
    { name: 'Drink', quantity: 1 },
  ],
  choices: [drink],
  available: true,
  position: 1,
  updatedAt: noon,
  ...fields,
});
async function open(...deals: Deal[]) {
  await app.repo().setMenuLink(company.id, true, slug);
  for (const saved of deals) await app.repo().saveDeal(saved);
}
const menuAt = (now: string) => publicMenu(app.repo(), slug, now);
const dealsOf = (menu: PublicMenu) => menu.categories[0]!.items.filter((item) => item.deal);

describe('deals on the public menu', () => {
  it('tells the page each deal’s state at the moment it asks, leaving out paused and ended ones', async () => {
    await open(
      deal({ name: 'Lunch Combo', schedule: lunch, regularPrice: 104900 }),
      deal({
        name: 'Dinner Combo',
        position: 2,
        regularPrice: 79900,
        schedule: { days: every, start: '19:00', end: '23:00' },
      }),
      deal({
        name: 'Daal Deal',
        position: 3,
        items: [{ name: 'Daal Makhani', quantity: 1, productId: daal.id }],
      }),
      deal({ name: 'Paused Combo', position: 4, available: false }),
      deal({
        name: 'Summer Combo',
        position: 5,
        schedule: { days: every, start: '00:00', end: '00:00', endDate: '2026-08-14' },
      }),
    );
    const menu = await menuAt(noon);
    expect(menu.categories[0]!.name).toBe('Deals');
    expect(
      dealsOf(menu).map((item) => [item.name, item.available, item.deal!.state, item.deal!.when]),
    ).toEqual([
      ['Lunch Combo', true, 'on', 'Mon–Fri 12:00–15:00'],
      ['Dinner Combo', false, 'later', 'Every day 19:00–23:00'],
      ['Daal Deal', false, 'sold_out', undefined],
    ]);
    // "You save" only for a real saving.
    expect(dealsOf(menu).map((item) => item.deal!.regularPrice)).toEqual([
      104900,
      undefined,
      undefined,
    ]);
    // At 15:00 lunch is over until tomorrow; the page shows it as on later, not gone.
    expect(dealsOf(await menuAt(afternoon))[0]).toMatchObject({
      name: 'Lunch Combo',
      available: false,
      deal: { state: 'later', when: 'Mon–Fri 12:00–15:00' },
    });
  });

  it('takes orders for deals alone, but not for a deal that is only on later', async () => {
    for (const product of products) await app.repo().saveProduct({ ...product, available: false });
    await open();
    expect((await menuAt(noon)).ordering.reason).toBe('unavailable');
    const dinner = deal({
      name: 'Dinner Combo',
      items: [{ name: 'Drink', quantity: 1 }],
      schedule: { days: every, start: '19:00', end: '23:00' },
    });
    await app.repo().saveDeal(dinner);
    expect((await menuAt(noon)).ordering.reason).toBe('unavailable');
    await app.repo().saveDeal({ ...dinner, schedule: undefined });
    const menu = await menuAt(noon);
    expect(menu.ordering.reason).not.toBe('unavailable');
    expect(dealsOf(menu).map((item) => item.available)).toEqual([true]);
  });

  it('prices a deal on the page exactly as the server does, picks and all', async () => {
    const combo = deal({ choices: [drink, side], regularPrice: 104900 });
    await open(combo);
    // Lines merge by their picks, whatever order they came in.
    let items: CartItem[] = addLine([], {
      productId: combo.id,
      quantity: 1,
      modifierIds: ['raita', 'fanta'],
    });
    items = addLine(items, { productId: combo.id, quantity: 1, modifierIds: ['fanta', 'raita'] });
    items = addLine(items, { productId: combo.id, quantity: 1, modifierIds: ['coke', 'fries'] });
    items = addLine(items, { productId: biryani.id, quantity: 1, modifierIds: [] });
    expect(items.map((item) => item.quantity)).toEqual([2, 1, 1]);
    const keepIds = items.map((item) => item.productId);
    const server = (now: string, deals: Deal[]) =>
      quoteWebCart(company, sellableCatalog(company, products, deals, now, { keepIds }), {
        items,
        fulfillment: 'pickup',
        customerName: 'Ali',
      });

    const preview = previewQuote(await menuAt(noon), { items, fulfillment: 'pickup' });
    const priced = server(noon, [combo]);
    expect(preview.quote!.items).toEqual(priced.quote.items);
    expect(preview.quote!.total).toBe(priced.quote.total);
    expect(priced.quote.total).toBe(2 * (79900 + 5000 + 3000) + 79900 + 45000);
    expect(preview.quote!.items[0]).toMatchObject({
      variant: 'Drink: Fanta, Side: Raita',
      choices: [
        { group: 'Drink', option: 'Fanta' },
        { group: 'Side', option: 'Raita' },
      ],
      includes: ['1 × Chicken Biryani', '1 × Drink'],
    });

    // Outside its times the page says what the server says, which reloads the menu.
    const timed = { ...combo, schedule: lunch };
    await app.repo().saveDeal(timed);
    const refused = (() => {
      try {
        server(afternoon, [timed]);
      } catch (error) {
        return error;
      }
    })();
    expect(refused).toBeInstanceOf(MenuOrderError);
    expect(refused).toMatchObject({ code: 'unavailable' });
    expect(previewQuote(await menuAt(afternoon), { items, fulfillment: 'pickup' })).toEqual({
      error:
        'Lunch Combo is unavailable right now. It is on Mon–Fri 12:00–15:00. Remove it to continue.',
    });
    expect((refused as MenuOrderError).message).toBe(
      'Lunch Combo is unavailable right now. It is on Mon–Fri 12:00–15:00. Remove it to continue.',
    );
  });
});

describe('order codes for deals', () => {
  // The deal runs 12:00–12:30 on weekdays; codes are made at 12:20.
  const combo = deal({ schedule: { ...lunch, end: '12:30' } });
  const at = (time: string) => vi.setSystemTime(new Date(`2026-10-21T${time}:00.000+05:00`));
  async function ready() {
    await open(combo);
    await app.repo().saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'connected',
        config: { phoneNumberId: '123', displayPhoneNumber: '923001112233' },
      },
      encryptSecret('meta-token'),
    );
  }
  // The bot's language, published as the dashboard does.
  async function speak(language: Language) {
    const config = { ...defaultBot, language };
    const revision = (await app.repo().getCompany(company.id))!.bot?.revision ?? 0;
    await app.repo().saveBot(
      company.id,
      {
        draft: config,
        revision: revision + 1,
        history: [],
        published: { version: revision + 1, config, publishedAt: noon, publishedBy: 'owner' },
      },
      revision,
    );
  }
  // A code for one Lunch Combo with this drink, made from the page for this number.
  async function codeFor(phone: string, pick = 'coke') {
    const res = await app.request(`/public/menu/${slug}/drafts`, {
      body: {
        phone,
        cart: {
          items: [{ productId: combo.id, quantity: 1, modifierIds: [pick], notes: '' }],
          fulfillment: 'pickup',
          customerName: 'Ali',
        },
        expectedTotal: pick === 'fanta' ? 84900 : 79900,
      },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { code: string }).code;
  }
  const send = async (digits: string, code: string) => {
    const now = new Date().toISOString();
    return handleTurn(
      app.repo(),
      (await app.repo().getCompany(company.id))!,
      createConversation(company.id, digits, 'whatsapp', now),
      {
        messageId: `wamid.${randomUUID()}`,
        text: `Hi! Please place my menu order. Code: ${code}`,
        now,
      },
    );
  };
  const pageOrders = async () =>
    (await app.repo().listOrders(company.id)).filter((o) => o.source === 'menu_page');

  it('refuses a code sent after the deal’s times, naming the deal in the chat’s language', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await ready();
      const replies: [Language, string][] = [
        [
          'en',
          "Lunch Combo is not available right now, so this order wasn't placed. Please open the menu link again.",
        ],
        [
          'ur',
          'Lunch Combo ابھی دستیاب نہیں ہے، اس لیے یہ آرڈر نہیں دیا گیا۔ براہ کرم مینو لنک دوبارہ کھولیں۔',
        ],
        [
          'roman-ur',
          'Lunch Combo abhi available nahi hai, is liye yeh order place nahi hua. Meherbani karke menu link dobara kholein.',
        ],
      ];
      for (const [index, [language, reply]] of replies.entries()) {
        await speak(language);
        at('12:20');
        const code = await codeFor(`0300 123456${index}`);
        at('12:35');
        const turn = await send(`92300123456${index}`, code);
        expect(turn.reply, language).toContain(reply);
        expect(turn.order).toBeUndefined();
      }
      expect(await pageOrders()).toEqual([]);
      expect(
        (await app.repo().listTraces(company.id))
          .filter((t) => t.action === 'menu_code_refused')
          .map((t) => t.detail),
      ).toEqual(Array(3).fill('Order code refused: deal not on.'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('places a code sent in time with its pick, shows the pick on a late code, and refuses a paused deal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await ready();
      at('12:20');
      const onTime = await codeFor('0300 1234567');
      at('12:21');
      const placed = await send('923001234567', onTime);
      expect(placed.order?.items[0]).toMatchObject({
        name: 'Lunch Combo',
        variant: 'Drink: Coke',
        choices: [{ group: 'Drink', option: 'Coke' }],
      });
      expect(placed.reply).toContain('1 × Lunch Combo (Drink: Coke) — Rs. 799');

      // A code that reached Orderly late is shown again, picks included, to send once more.
      const late = await codeFor('0300 1234568', 'fanta');
      const chat: Conversation = {
        ...createConversation(company.id, '923001234568', 'whatsapp', new Date().toISOString()),
        version: 1,
      };
      expect(await app.repo().saveConversation(chat, 0)).toBe(true);
      const again = await redeemMenuDraft(
        app.repo(),
        company,
        products,
        await app.repo().listDeals(company.id),
        chat,
        {
          messageId: 'wamid.late',
          text: `Hi! Please place my menu order. Code: ${late}`,
          now: new Date().toISOString(),
          late: true,
        },
        menuCodeIn(late)!,
      );
      expect(again.order).toBeUndefined();
      expect(again.reply).toContain('1 × Lunch Combo (Drink: Fanta) — Rs. 849');

      // Paused by the owner after the code was made, still inside its times.
      const paused = await codeFor('0300 1234569');
      await app.repo().saveDeal({ ...combo, available: false });
      at('12:22');
      expect((await send('923001234569', paused)).reply).toContain(
        "Lunch Combo is not available right now, so this order wasn't placed.",
      );
      expect(await pageOrders()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
