import { describe, expect, it } from 'vitest';
import { buildWebOrder, MenuOrderError, quoteWebCart } from '../src/domain/web-order';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { explanationHeadline } from '../src/shared/explain';
import { sellableCatalog } from '../src/shared/deals';
import type { WebCart } from '../src/shared/menu';
import type { Company, Conversation, Deal, Product } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const karahi = products.find((p) => p.name === 'Chicken Karahi')!;
const daal = products.find((p) => p.name === 'Daal Makhani')!;
const now = '2026-10-16T10:00:00.000Z';
const earlier = '2026-10-16T09:00:00.000Z';
const chat = (): Conversation => ({
  ...createConversation(company.id, '923001234567', 'whatsapp', earlier),
  version: 3,
  cart: { items: [], revision: 7, status: 'building' },
  pendingItemChoice: {
    candidateProductIds: [],
    quantity: 1,
    requestedOptionNames: [],
    notes: '',
    originalText: 'x',
  },
});
const pickup: WebCart = {
  items: [
    { productId: biryani.id, quantity: 2, modifierIds: [], notes: '' },
    {
      productId: karahi.id,
      quantity: 1,
      variantId: karahi.variants[0]!.id,
      modifierIds: [karahi.modifiers[0]!.id],
      notes: '',
    },
  ],
  fulfillment: 'pickup',
  customerName: ' Ali ',
};
const build = (
  cart: WebCart = pickup,
  options: Partial<Parameters<typeof buildWebOrder>[4]> = {},
  restaurant: Company = company,
  conversation: Conversation = chat(),
  catalog: Product[] = products,
) =>
  buildWebOrder(restaurant, catalog, conversation, cart, {
    now,
    submissionKey: `${restaurant.id}:${conversation.id}:menu-link:nonce-00001`,
    ...options,
  });
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof MenuOrderError) return { code: error.code, total: error.total };
    throw error;
  }
  throw new Error('Expected a refusal');
};

describe('menu page orders', () => {
  it('saves a pending live order from the menu page and marks the cart submitted', () => {
    const before = chat();
    const { order, conversation, reply, replyId } = build(pickup, {}, company, before);
    expect(order).toMatchObject({
      status: 'pending',
      sandbox: false,
      source: 'menu_page',
      customerName: 'Ali',
      fulfillment: 'pickup',
      total: 2 * 45000 + 120000 + 10000,
      customerPhone: '923001234567',
    });
    expect(conversation.cart).toEqual({
      items: [
        { productId: biryani.id, quantity: 2, modifierIds: [], notes: '' },
        {
          productId: karahi.id,
          quantity: 1,
          variantId: karahi.variants[0]!.id,
          modifierIds: [karahi.modifiers[0]!.id],
          notes: '',
        },
      ],
      fulfillment: 'pickup',
      customerName: 'Ali',
      revision: 8,
      status: 'submitted',
      orderId: order.id,
    });
    expect(conversation.pendingItemChoice).toBeUndefined();
    expect(conversation.version).toBe(4);
    expect(conversation.updatedAt).toBe(now);
    expect(conversation.lastInboundAt).toBe(before.lastInboundAt);
    expect(conversation.customerName).toBe('Ali');
    expect(replyId).toBe(`menu-order:${order.id}`);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({ id: replyId, role: 'assistant', text: reply });
    expect(reply).toContain('You ordered from our menu page:');
    expect(reply).toContain('2 × Chicken Biryani — Rs. 900');
    expect(reply).toContain('1 × Chicken Karahi (Half) + Extra butter — Rs. 1,300');
    expect(reply).toContain('Pickup · Ali');
    expect(reply).toContain(
      `Order ${order.reference} received — Rs. 2,200. Awaiting restaurant acceptance.`,
    );
    const explanation = conversation.messages[0]!.explanation!;
    expect(explanation).toMatchObject({
      ai: { called: false, skipped: 'menu_page' },
      steps: ['menu_page_order'],
      outcome: 'order',
      orderReference: order.reference,
      decision: { parts: ['engine'], modelText: 'none', corrections: [] },
    });
    expect(explanationHeadline(explanation)).toBe(
      `The customer confirmed, so order ${order.reference} was saved for staff to accept.`,
    );
  });

  it('records the customer’s code message, which moves the reply window', () => {
    const { conversation, replyId } = build(pickup, {
      customerMessage: {
        id: 'wamid-1',
        text: 'Hi! Please place my menu order. Code: OM-ABCD-EFGH',
      },
    });
    expect(conversation.lastInboundAt).toBe(now);
    expect(replyId).toBe('wamid-1:reply');
    expect(conversation.messages.map((m) => [m.id, m.role])).toEqual([
      ['wamid-1', 'customer'],
      ['wamid-1:reply', 'assistant'],
    ]);
  });

  it('delivers to a known area with its fee', () => {
    const { order, reply } = build({
      ...pickup,
      fulfillment: 'delivery',
      address: 'House 1, Street 2, Gulberg III',
      zone: 'gulberg',
    });
    expect(order).toMatchObject({ zone: 'Gulberg', deliveryFee: 15000, total: 235000 });
    expect(reply).toContain('Delivery: House 1, Street 2, Gulberg III (Gulberg)');
  });

  it('asks for a phone call note when the restaurant confirms by phone', () => {
    const bot = { ...defaultBot, requirePhoneConfirmation: true };
    const restaurant: Company = {
      ...company,
      bot: {
        draft: bot,
        revision: 1,
        history: [],
        published: { version: 1, config: bot, publishedAt: now, publishedBy: 'owner' },
      },
    };
    const { order, reply } = build(pickup, {}, restaurant);
    expect(order.phoneConfirmationRequired).toBe(true);
    expect(reply).toContain('Restaurant staff will call to confirm before accepting your order.');
  });

  it.each([
    ['closed', { ...company, openingHours: { start: '09:00', end: '10:00', days: [] } }, chat()],
    ['bot_off', { ...company, botEnabled: false }, chat()],
    ['staff', company, { ...chat(), mode: 'human' as const }],
    ['blocked', company, { ...chat(), blocked: { at: now, blockId: 'b' } }],
  ])('refuses when %s', (code, restaurant, conversation) => {
    expect(refusal(() => build(pickup, {}, restaurant as Company, conversation)).code).toBe(code);
  });

  it('refuses carts it cannot take', () => {
    const line = pickup.items[0]!;
    expect(refusal(() => build({ ...pickup, items: Array(41).fill(line) })).code).toBe('invalid');
    expect(refusal(() => build({ ...pickup, items: [] })).code).toBe('invalid');
    expect(refusal(() => build({ ...pickup, customerName: 'A' })).code).toBe('invalid');
    expect(
      refusal(() => build({ ...pickup, fulfillment: 'delivery', address: 'Somewhere far away' }))
        .code,
    ).toBe('invalid');
    expect(
      refusal(() => build({ ...pickup, fulfillment: 'delivery', zone: 'Gulberg', address: 'x' }))
        .code,
    ).toBe('invalid');
    const pickupOnly = { ...defaultBot, fulfillment: 'pickup' as const };
    expect(
      refusal(() =>
        build(
          { ...pickup, fulfillment: 'delivery', zone: 'Gulberg', address: 'House 1, Gulberg' },
          {},
          {
            ...company,
            bot: {
              draft: pickupOnly,
              revision: 1,
              history: [],
              published: { version: 1, config: pickupOnly, publishedAt: now, publishedBy: 'o' },
            },
          },
        ),
      ).code,
    ).toBe('invalid');
    expect(
      refusal(() =>
        build({
          ...pickup,
          items: [{ productId: daal.id, quantity: 1, modifierIds: [], notes: '' }],
        }),
      ).code,
    ).toBe('unavailable');
    expect(
      refusal(() =>
        build({
          ...pickup,
          items: [{ productId: karahi.id, quantity: 1, modifierIds: [], notes: '' }],
        }),
      ).code,
    ).toBe('invalid');
  });

  it('refuses a reply too long for one message', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...biryani,
      id: `${biryani.id.slice(0, -2)}${String(i).padStart(2, '0')}`,
      name: `Biryani ${'x'.repeat(80)} ${i}`,
    }));
    const cart: WebCart = {
      ...pickup,
      items: many.map((p) => ({ productId: p.id, quantity: 1, modifierIds: [], notes: '' })),
    };
    expect(refusal(() => build(cart, {}, company, chat(), many)).code).toBe('too_large');
  });

  it('refuses a changed total and says what it is now', () => {
    expect(refusal(() => build(pickup, { expectedTotal: 1 }))).toEqual({
      code: 'price_changed',
      total: 220000,
    });
    expect(build(pickup, { expectedTotal: 220000 }).order.total).toBe(220000);
  });

  it('prices a page cart the same way as the chat', () => {
    expect(quoteWebCart(company, products, pickup).quote.total).toBe(220000);
  });
});

describe('deals ordered from the menu page', () => {
  // `now` is Friday 15:00 in Karachi.
  const every = [0, 1, 2, 3, 4, 5, 6];
  const deal = (fields: Partial<Deal> = {}): Deal => ({
    id: 'deal-1',
    companyId: company.id,
    name: 'Deal 1',
    description: '',
    emoji: '🎁',
    aliases: [],
    price: 79900,
    regularPrice: 104900,
    items: [
      { name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
      { name: 'Drink', quantity: 1 },
    ],
    choices: [
      {
        id: 'drink',
        name: 'Drink',
        options: [
          { id: 'coke', name: 'Coke', price: 0 },
          { id: 'sprite', name: 'Sprite', price: 0 },
          { id: 'fanta', name: 'Fanta', price: 5000 },
        ],
      },
      {
        id: 'side',
        name: 'Side',
        options: [
          { id: 'fries', name: 'Fries', price: 0 },
          { id: 'raita', name: 'Raita', price: 3000 },
        ],
      },
    ],
    available: true,
    position: 1,
    updatedAt: earlier,
    ...fields,
  });
  const dealCart = (modifierIds: string[], line: Partial<WebCart['items'][number]> = {}) => ({
    ...pickup,
    items: [{ productId: 'deal-1', quantity: 1, modifierIds, notes: '', ...line }],
  });
  // As the server sells it: at `now`, keeping a paused or ended deal the cart holds.
  const sold = (d: Deal, keep = true) =>
    sellableCatalog(company, products, [d], now, keep ? { keepIds: [d.id] } : {});

  it('orders a deal as one line with its picks in group order, and drops a pending question', () => {
    const asked: Conversation = {
      ...chat(),
      pendingDealChoice: { productId: 'deal-1', quantity: 1, picked: [], notes: '' },
    };
    const { order, reply, conversation } = build(
      dealCart(['raita', 'sprite']),
      { expectedTotal: 82900 },
      company,
      asked,
      sold(deal()),
    );
    expect(order.items).toEqual([
      {
        productId: 'deal-1',
        name: 'Deal 1',
        quantity: 1,
        unitPrice: 82900,
        variant: 'Drink: Sprite, Side: Raita',
        modifiers: [],
        notes: '',
        total: 82900,
        choices: [
          { group: 'Drink', option: 'Sprite' },
          { group: 'Side', option: 'Raita' },
        ],
        includes: ['1 × Chicken Biryani', '1 × Drink'],
      },
    ]);
    expect(reply).toContain('1 × Deal 1 (Drink: Sprite, Side: Raita) — Rs. 829');
    expect(conversation.pendingDealChoice).toBeUndefined();
    expect(conversation.pendingItemChoice).toBeUndefined();
    // The picks' order in the cart changes nothing.
    expect(
      build(dealCart(['sprite', 'raita']), {}, company, chat(), sold(deal())).order.items,
    ).toEqual(order.items);
  });

  it.each([
    [
      'later',
      deal({ schedule: { days: every, start: '18:00', end: '22:00' } }),
      'Deal 1 is unavailable right now. It is on Every day 18:00–22:00. Remove it to continue.',
    ],
    [
      'ended',
      deal({ schedule: { days: every, start: '00:00', end: '00:00', endDate: '2026-10-15' } }),
      'Deal 1 is unavailable right now. It has ended. Remove it to continue.',
    ],
    [
      'sold out',
      deal({ items: [{ name: 'Daal Makhani', quantity: 1, productId: daal.id }] }),
      'Deal 1 is unavailable right now. It is sold out. Remove it to continue.',
    ],
    [
      'paused',
      deal({ available: false }),
      'Deal 1 is unavailable right now. Remove it to continue.',
    ],
  ])('refuses a deal that is %s as unavailable, so the page reloads the menu', (_, d, message) => {
    const cart = dealCart(['coke', 'fries']);
    expect(refusal(() => build(cart, {}, company, chat(), sold(d))).code).toBe('unavailable');
    expect(() => quoteWebCart(company, sold(d), cart)).toThrow(message);
    // A path that forgot to keep the cart's deal still refuses it.
    expect(refusal(() => build(cart, {}, company, chat(), sold(d, false))).code).toBe(
      'unavailable',
    );
  });

  it.each([
    ['a missing pick', dealCart(['coke']), 'Choose Side for Deal 1: Fries, Raita.'],
    ['an unknown pick', dealCart(['coke', 'chips']), 'Invalid choice for Deal 1.'],
    ['two picks from one group', dealCart(['coke', 'sprite', 'fries']), 'Choose one Drink'],
    ['the same pick twice', dealCart(['coke', 'coke', 'fries']), 'cannot be selected twice'],
    ['a size', dealCart(['coke', 'fries'], { variantId: 'large' }), 'Invalid option for Deal 1.'],
  ])('refuses %s as invalid', (_, cart, message) => {
    expect(refusal(() => build(cart, {}, company, chat(), sold(deal()))).code).toBe('invalid');
    expect(() => quoteWebCart(company, sold(deal()), cart)).toThrow(message);
  });
});
