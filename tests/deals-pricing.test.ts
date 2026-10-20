import { describe, expect, it } from 'vitest';
import { CartError, quoteCart } from '../src/domain/pricing';
import { buildWebOrder, MenuOrderError, quoteWebCart } from '../src/domain/web-order';
import { createConversation } from '../src/domain/engine';
import { sellableCatalog } from '../src/shared/deals';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { WebCart } from '../src/shared/menu';
import type { Cart, CartItem, Conversation, Deal, Product } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const karahi = products.find((p) => p.name === 'Chicken Karahi')!;
const daal = products.find((p) => p.name === 'Daal Makhani')!;
// Friday 13:00 in Karachi; the seed restaurant is open all day.
const now = '2026-08-14T08:00:00.000Z';
const DEAL_ID = 'bbbbbbbb-0000-4000-a000-000000000001';
const deal = (over: Partial<Deal> = {}): Deal => ({
  id: DEAL_ID,
  companyId: company.id,
  name: 'Deal 1',
  description: 'Zinger, fries and a drink.',
  emoji: '🎁',
  aliases: [],
  price: 79900,
  regularPrice: 104900,
  items: [
    { name: 'Zinger burger', quantity: 1 },
    { name: 'Fries', quantity: 1 },
    { name: 'Drink', quantity: 1 },
  ],
  choices: [
    {
      id: 'g-drink',
      name: 'Drink',
      options: [
        { id: 'o-coke', name: 'Coke', price: 0 },
        { id: 'o-sprite', name: 'Sprite', price: 0 },
        { id: 'o-fanta', name: 'Fanta', price: 5000 },
      ],
    },
    {
      id: 'g-side',
      name: 'Side',
      options: [
        { id: 'o-fries', name: 'Fries', price: 0 },
        { id: 'o-wings', name: 'Wings', price: 10000 },
      ],
    },
  ],
  available: true,
  position: 1,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});
const catalog = (over: Partial<Deal> = {}, at = now) =>
  sellableCatalog(company, products, [deal(over)], at, { keepIds: [DEAL_ID] });
// One Deal 1 (Coke, Fries) unless items are given.
const cartOf = (...items: Partial<CartItem>[]): Cart => ({
  items: (items.length ? items : [{}]).map((item) => ({
    productId: DEAL_ID,
    quantity: 1,
    modifierIds: ['o-coke', 'o-fries'],
    notes: '',
    ...item,
  })),
  fulfillment: 'pickup',
  customerName: 'Ali',
  revision: 0,
  status: 'building',
});
const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof CartError) return { kind: error.kind, message: error.message };
    throw error;
  }
  throw new Error('Expected a CartError');
};

// The seed cart's hash, captured from quoteCart before deals existed.
const SEED_HASH =
  '{"companyId":"11111111-1111-4111-a111-111111111111","items":[{"productId":"33333333-3333-4333-a333-000000000001",' +
  '"name":"Chicken Biryani","quantity":2,"unitPrice":71000,"modifiers":["Extra chicken","Extra raita"],' +
  '"notes":"less spicy","total":142000},{"productId":"33333333-3333-4333-a333-000000000002","name":"Chicken Karahi",' +
  '"quantity":1,"unitPrice":230000,"variant":"Full","modifiers":["Extra butter"],"notes":"","total":230000}],' +
  '"subtotal":372000,"deliveryFee":15000,"total":387000,"fulfillment":"delivery","customerName":"Ali",' +
  '"address":"House 1 street 2","zone":"Gulberg"}';
const seedCart: Cart = {
  items: [
    {
      productId: biryani.id,
      quantity: 2,
      modifierIds: [biryani.modifiers[1]!.id, biryani.modifiers[0]!.id],
      notes: 'less spicy',
    },
    {
      productId: karahi.id,
      quantity: 1,
      variantId: karahi.variants[1]!.id,
      modifierIds: [karahi.modifiers[0]!.id],
      notes: '',
    },
  ],
  fulfillment: 'delivery',
  customerName: 'Ali',
  address: 'House 1 street 2',
  zone: 'Gulberg',
  revision: 0,
  status: 'building',
};

describe('pricing a deal', () => {
  it('charges the deal price plus the extra of each pick, as one line', () => {
    const quote = quoteCart(
      company,
      catalog(),
      cartOf({ quantity: 2, modifierIds: ['o-wings', 'o-fanta'], notes: 'no ice' }),
    );
    expect(quote.items).toEqual([
      {
        productId: DEAL_ID,
        name: 'Deal 1',
        quantity: 2,
        unitPrice: 79900 + 5000 + 10000,
        variant: 'Drink: Fanta, Side: Wings',
        modifiers: [],
        notes: 'no ice',
        total: 2 * 94900,
        choices: [
          { group: 'Drink', option: 'Fanta' },
          { group: 'Side', option: 'Wings' },
        ],
        includes: ['1 × Zinger burger', '1 × Fries', '1 × Drink'],
      },
    ]);
    expect(quote.total).toBe(189800);
  });

  it('pins the stored shape of a deal line', () => {
    const [line] = quoteCart(
      company,
      catalog(),
      cartOf({ quantity: 2, modifierIds: ['o-wings', 'o-fanta'], notes: 'no ice' }),
    ).items;
    expect(JSON.stringify(line)).toBe(
      `{"productId":"${DEAL_ID}","name":"Deal 1","quantity":2,"unitPrice":94900,` +
        '"variant":"Drink: Fanta, Side: Wings","modifiers":[],"notes":"no ice","total":189800,' +
        '"choices":[{"group":"Drink","option":"Fanta"},{"group":"Side","option":"Wings"}],' +
        '"includes":["1 × Zinger burger","1 × Fries","1 × Drink"]}',
    );
    // With no choice groups there is no variant, and choices is [].
    const [plain] = quoteCart(company, catalog({ choices: [] }), cartOf({ modifierIds: [] })).items;
    expect(JSON.stringify(plain)).toBe(
      `{"productId":"${DEAL_ID}","name":"Deal 1","quantity":1,"unitPrice":79900,"modifiers":[],` +
        '"notes":"","total":79900,"choices":[],"includes":["1 × Zinger burger","1 × Fries","1 × Drink"]}',
    );
    expect('variant' in plain!).toBe(false);
  });

  it('lists picks in group order whatever order the ids come in', () => {
    const a = quoteCart(company, catalog(), cartOf({ modifierIds: ['o-wings', 'o-sprite'] }));
    const b = quoteCart(company, catalog(), cartOf({ modifierIds: ['o-sprite', 'o-wings'] }));
    expect(a.hash).toBe(b.hash);
    expect(a.items[0]!.variant).toBe('Drink: Sprite, Side: Wings');
  });

  it('keeps savings, state, times and description out of the hash', () => {
    const cart = cartOf({ modifierIds: ['o-coke', 'o-fries'] });
    const lunch = { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' };
    const shown = catalog({ schedule: lunch });
    expect(shown[0]!.deal!.when).toBe('Mon–Fri 12:00–15:00');
    const plain = catalog({ regularPrice: undefined, description: 'Changed.' });
    expect(quoteCart(company, shown, cart).hash).toBe(quoteCart(company, plain, cart).hash);
    // What the customer pays for does change it.
    const pricier = deal().choices.map((g) => ({
      ...g,
      options: g.options.map((o) => (o.id === 'o-coke' ? { ...o, price: 2000 } : o)),
    }));
    expect(quoteCart(company, catalog({ choices: pricier }), cart).hash).not.toBe(
      quoteCart(company, shown, cart).hash,
    );
    const items = [{ name: 'Zinger burger', quantity: 2 }];
    expect(quoteCart(company, catalog({ items }), cart).hash).not.toBe(
      quoteCart(company, shown, cart).hash,
    );
  });

  it('prices a deal next to dishes, and leaves dish lines exactly as before', () => {
    expect(quoteCart(company, products, seedCart).hash).toBe(SEED_HASH);
    // Merging deals into the catalog changes nothing for a cart without one.
    expect(quoteCart(company, catalog(), seedCart).hash).toBe(SEED_HASH);
    const mixed = quoteCart(company, catalog(), {
      ...seedCart,
      items: [...seedCart.items, cartOf({ modifierIds: ['o-fanta', 'o-fries'] }).items[0]!],
    });
    expect(mixed.items.map((line) => line.total)).toEqual([142000, 230000, 84900]);
    expect(mixed.subtotal).toBe(142000 + 230000 + 84900);
    expect(JSON.stringify(mixed.items.slice(0, 2))).toBe(
      JSON.stringify(JSON.parse(SEED_HASH).items),
    );
    expect('choices' in mixed.items[0]! || 'includes' in mixed.items[1]!).toBe(false);
  });
});

describe('cart errors', () => {
  const bad = (price: number): Product[] =>
    products.map((p) => (p.id === biryani.id ? { ...p, price } : p));
  const dish = (item: Partial<CartItem>): Cart => ({
    ...cartOf({ productId: biryani.id, modifierIds: [], ...item }),
  });
  it.each([
    [
      'an empty cart',
      () => quoteCart(company, products, { ...cartOf(), items: [] }),
      'invalid',
      'Your cart is empty. Choose something from the menu first.',
    ],
    [
      'a very large cart',
      () =>
        quoteCart(
          company,
          products,
          cartOf(...Array.from({ length: 41 }, () => ({ productId: biryani.id, modifierIds: [] }))),
        ),
      'invalid',
      'Please ask staff to help with this large order.',
    ],
    [
      'an item not on the menu',
      () => quoteCart(company, products, dish({ productId: 'gone' })),
      'unavailable',
      'An item is unavailable. Remove it or ask staff for help.',
    ],
    [
      'an item switched off',
      () => quoteCart(company, products, dish({ productId: daal.id })),
      'unavailable',
      'Daal Makhani is unavailable. Remove it or ask staff for help.',
    ],
    [
      'a quantity of 0',
      () => quoteCart(company, products, dish({ quantity: 0 })),
      'invalid',
      'Choose a quantity between 1 and 50.',
    ],
    [
      'a missing size',
      () => quoteCart(company, products, dish({ productId: karahi.id })),
      'invalid',
      'Choose an option for Chicken Karahi: Half, Full.',
    ],
    [
      'an unknown size',
      () => quoteCart(company, products, dish({ productId: karahi.id, variantId: 'nope' })),
      'invalid',
      'Choose an option for Chicken Karahi: Half, Full.',
    ],
    [
      'an extra twice',
      () =>
        quoteCart(
          company,
          products,
          dish({ modifierIds: [biryani.modifiers[0]!.id, biryani.modifiers[0]!.id] }),
        ),
      'invalid',
      'The same extra cannot be selected twice.',
    ],
    [
      'an unknown extra',
      () => quoteCart(company, products, dish({ modifierIds: ['nope'] })),
      'invalid',
      'Invalid extra for Chicken Biryani.',
    ],
    [
      'an unknown delivery area',
      () => quoteCart(company, products, { ...dish({}), fulfillment: 'delivery', zone: 'Mars' }),
      'invalid',
      'Choose a delivery area: Gulberg, Model Town, DHA.',
    ],
    [
      'a broken price',
      () => quoteCart(company, bad(-1), dish({})),
      'invalid',
      'Invalid catalog price. Please ask staff for help.',
    ],
    [
      'a deal outside its times',
      () =>
        quoteCart(
          company,
          catalog({ schedule: { days: [1, 2, 3, 4, 5], start: '18:00', end: '20:00' } }),
          cartOf(),
        ),
      'unavailable',
      'Deal 1 is unavailable right now. It is on Mon–Fri 18:00–20:00. Remove it to continue.',
    ],
    [
      'a deal that has ended',
      () =>
        quoteCart(
          company,
          catalog({
            schedule: {
              days: [1, 2, 3, 4, 5],
              start: '12:00',
              end: '15:00',
              endDate: '2026-08-01',
            },
          }),
          cartOf(),
        ),
      'unavailable',
      'Deal 1 is unavailable right now. It has ended. Remove it to continue.',
    ],
    [
      'a deal with an item sold out',
      () =>
        quoteCart(
          company,
          catalog({ items: [{ name: 'Daal', quantity: 1, productId: daal.id }] }),
          cartOf(),
        ),
      'unavailable',
      'Deal 1 is unavailable right now. It is sold out. Remove it to continue.',
    ],
    [
      'a paused deal',
      () => quoteCart(company, catalog({ available: false }), cartOf()),
      'unavailable',
      'Deal 1 is unavailable right now. Remove it to continue.',
    ],
    [
      'a paused deal left out of the menu',
      () =>
        quoteCart(
          company,
          sellableCatalog(company, products, [deal({ available: false })], now),
          cartOf(),
        ),
      'unavailable',
      'An item is unavailable. Remove it or ask staff for help.',
    ],
    [
      'a deal quantity of 51',
      () => quoteCart(company, catalog(), cartOf({ quantity: 51 })),
      'invalid',
      'Choose a quantity between 1 and 50.',
    ],
    [
      'a size on a deal',
      () => quoteCart(company, catalog(), cartOf({ variantId: karahi.variants[0]!.id })),
      'invalid',
      'Invalid option for Deal 1.',
    ],
    [
      'the same pick twice',
      () => quoteCart(company, catalog(), cartOf({ modifierIds: ['o-coke', 'o-coke', 'o-fries'] })),
      'invalid',
      'The same choice cannot be selected twice.',
    ],
    [
      'an unknown pick',
      () =>
        quoteCart(company, catalog(), cartOf({ modifierIds: ['o-coke', 'o-fries', 'o-pepsi'] })),
      'invalid',
      'Invalid choice for Deal 1.',
    ],
    [
      "a dish's extra as a pick",
      () =>
        quoteCart(
          company,
          catalog(),
          cartOf({ modifierIds: ['o-coke', biryani.modifiers[0]!.id] }),
        ),
      'invalid',
      'Invalid choice for Deal 1.',
    ],
    [
      'two picks from one group',
      () =>
        quoteCart(company, catalog(), cartOf({ modifierIds: ['o-coke', 'o-sprite', 'o-fries'] })),
      'invalid',
      'Choose one Drink for Deal 1.',
    ],
    [
      'a group with no pick',
      () => quoteCart(company, catalog(), cartOf({ modifierIds: ['o-sprite'] })),
      'invalid',
      'Choose Side for Deal 1: Fries, Wings.',
    ],
    [
      'no picks at all',
      () => quoteCart(company, catalog(), cartOf({ modifierIds: [] })),
      'invalid',
      'Choose Drink for Deal 1: Coke, Sprite, Fanta.',
    ],
  ] as const)('refuses %s', (_, run, kind, message) => {
    expect(failure(run)).toEqual({ kind, message });
  });

  it('is still an ordinary Error for the engine, which shows the message', () => {
    const error = (() => {
      try {
        quoteCart(company, catalog(), cartOf({ modifierIds: [] }));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CartError);
  });
});

describe('menu page orders with deals', () => {
  const web = (item: Partial<CartItem> = {}): WebCart => ({
    items: [
      { productId: DEAL_ID, quantity: 1, modifierIds: ['o-coke', 'o-fries'], notes: '', ...item },
    ],
    fulfillment: 'pickup',
    customerName: 'Ali',
  });
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      if (error instanceof MenuOrderError) return error.code;
      throw error;
    }
    throw new Error('Expected a refusal');
  };

  it('sends unavailable deals back to the menu and bad picks to the order', () => {
    const lunch = { days: [1, 2, 3, 4, 5], start: '18:00', end: '20:00' };
    expect(code(() => quoteWebCart(company, catalog({ schedule: lunch }), web()))).toBe(
      'unavailable',
    );
    expect(code(() => quoteWebCart(company, catalog({ available: false }), web()))).toBe(
      'unavailable',
    );
    expect(code(() => quoteWebCart(company, catalog(), web({ modifierIds: ['o-coke'] })))).toBe(
      'invalid',
    );
    expect(
      code(() =>
        quoteWebCart(company, catalog(), web({ modifierIds: ['o-coke', 'o-sprite', 'o-fries'] })),
      ),
    ).toBe('invalid');
    expect(
      code(() => quoteWebCart(company, catalog(), web({ variantId: karahi.variants[0]!.id }))),
    ).toBe('invalid');
  });

  it('takes the kind from pricing, and reads the wording only for other errors', () => {
    // An item whose name says "unavailable" no longer turns a bad extra into a reload.
    const odd = { ...biryani, id: 'odd-item', name: 'Unavailable Special' };
    expect(
      code(() =>
        quoteWebCart(company, [...products, odd], {
          ...web({ productId: 'odd-item', modifierIds: ['nope'] }),
        }),
      ),
    ).toBe('invalid');
    const throwing = (message: string): Product[] => [
      {
        ...biryani,
        get variants(): Product['variants'] {
          throw new Error(message);
        },
      },
    ];
    const dishCart = web({ productId: biryani.id, modifierIds: [] });
    expect(
      code(() => quoteWebCart(company, throwing('Biryani is unavailable today'), dishCart)),
    ).toBe('unavailable');
    expect(code(() => quoteWebCart(company, throwing('Something broke'), dishCart))).toBe(
      'invalid',
    );
  });

  it('places a deal order, shows the picks and clears any question the bot asked', () => {
    const conversation: Conversation = {
      ...createConversation(company.id, '923001234567', 'whatsapp', '2026-08-14T07:00:00.000Z'),
      pendingItemChoice: {
        candidateProductIds: [],
        quantity: 1,
        requestedOptionNames: [],
        notes: '',
        originalText: 'x',
      },
      pendingDealChoice: { productId: DEAL_ID, quantity: 1, picked: ['o-coke'], notes: '' },
    };
    const result = buildWebOrder(
      company,
      catalog(),
      conversation,
      web({ quantity: 2, modifierIds: ['o-wings', 'o-fanta'] }),
      { now, submissionKey: `${company.id}:${conversation.id}:menu-link:deal-00001` },
    );
    expect(result.conversation.pendingDealChoice).toBeUndefined();
    expect(result.conversation.pendingItemChoice).toBeUndefined();
    expect(result.reply).toContain('2 × Deal 1 (Drink: Fanta, Side: Wings) — Rs. 1,898');
    expect(result.order.items[0]).toMatchObject({
      choices: [
        { group: 'Drink', option: 'Fanta' },
        { group: 'Side', option: 'Wings' },
      ],
      includes: ['1 × Zinger burger', '1 × Fries', '1 × Drink'],
    });
  });
});
