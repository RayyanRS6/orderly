import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { sellableCatalog } from '../src/shared/deals';
import { seedCompanies } from '../src/shared/seed';
import type { BotAction, Deal, DealChoiceGroup, ModelResponse, Product } from '../src/shared/types';

// One question at a time (round-4 review findings 1-5, round-5 findings 1-5). A dish's "which
// one?" goes first and a deal missing a choice waits behind it, to be asked once that is over;
// the adds that answer the deal whose choice is open are decided before any runs, so wherever
// the AI lists them they take on its earlier picks and notes, up to the count asked; a deal
// added in full is never asked again. Bun & Co. is open all day; Tuesday 20 October 2026 at
// 13:00 in Karachi.
const company = seedCompanies[1]!;
const now = '2026-10-20T08:00:00.000Z';
const dish = (id: string, name: string, aliases: string[] = [], price = 12000): Product => ({
  id,
  companyId: company.id,
  name,
  description: '',
  category: 'Menu',
  price,
  available: true,
  emoji: '🍔',
  aliases,
  variants: [],
  modifiers: [],
});
const drink: DealChoiceGroup = {
  id: 'g-drink',
  name: 'Drink',
  options: [
    { id: 'o-pepsi', name: 'Pepsi', price: 0 },
    { id: 'o-7up', name: '7up', price: 0 },
    { id: 'o-mirinda', name: 'Mirinda', price: 5000 },
  ],
};
const drinkN = (n: number): DealChoiceGroup => ({
  id: `g-drink${n}`,
  name: `Drink ${n}`,
  options: drink.options.map((option) => ({ ...option, id: `${option.id}-${n}` })),
});
const side: DealChoiceGroup = {
  id: 'g-side',
  name: 'Side',
  options: [
    { id: 'o-fries', name: 'Fries', price: 0 },
    { id: 'o-wings', name: 'Wings', price: 10000 },
  ],
};
const deal = (
  id: string,
  name: string,
  position: number,
  choices: DealChoiceGroup[] = [],
): Deal => ({
  id,
  companyId: company.id,
  name,
  description: '',
  emoji: '🎁',
  aliases: [],
  price: 61000,
  items: [{ name: 'Zinger burger', quantity: 1 }],
  choices,
  available: true,
  position,
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const dishes = [
  dish('zinger', 'Zinger Burger', ['zinger'], 55000),
  dish('chb', 'Chicken Burger', [], 45000),
  dish('pepsi', 'Pepsi 345ml', ['pepsi']),
  dish('water', 'Mineral Water', ['water', 'pani'], 8000),
];
const dealList = [
  deal('d1', 'Deal 1', 1, [drink]),
  deal('d5', 'Deal 5', 5, [drinkN(1), drinkN(2)]),
  deal('d6', 'Deal 6', 6, [drink, side]),
  deal('c1', 'Combo 1', 7),
  deal('c2', 'Combo 2', 8, [drink]),
  deal('c3', 'Combo 3', 9),
  deal('zd', 'Zinger Deal', 10, [drink]),
  deal('bd', 'Burger Deal', 11, [drink]),
];
const products = sellableCatalog(company, dishes, dealList, now, { all: true });
// The same with Pepsi in two sizes, and Deals 2, 3 and 4 (only Deal 3 with a choice).
const wider = sellableCatalog(
  company,
  [...dishes, dish('pepsi15', 'Pepsi 1.5L', [], 25000)],
  [...dealList, deal('d2', 'Deal 2', 2), deal('d3', 'Deal 3', 3, [drink]), deal('d4', 'Deal 4', 4)],
  now,
  { all: true },
);
const ok: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' };
const add = (
  productId: string,
  quantity = 1,
  modifierIds: string[] = [],
  notes?: string,
): BotAction => ({ type: 'add_item', productId, quantity, modifierIds, ...(notes && { notes }) });
const remove = (productId: string): BotAction => ({ type: 'remove_item', productId });
const which = (ids: string[], quantity = 1): BotAction => ({
  type: 'clarify_item',
  candidateProductIds: ids,
  quantity,
});
function chat(menu = products) {
  let conversation = createConversation(company.id, '923001234567', 'whatsapp', now);
  let n = 0;
  return {
    get conversation() {
      return conversation;
    },
    get items() {
      return conversation.cart.items.map(
        (item) =>
          `${item.productId} ×${item.quantity}${item.modifierIds.length ? ` [${item.modifierIds.join(', ')}]` : ''}${item.notes ? ` "${item.notes}"` : ''}`,
      );
    },
    // Without `actions`, local rules (no AI). `on`: the menu at this message, if it changed.
    send(
      text: string,
      actions?: BotAction[],
      response: ModelResponse | undefined = ok,
      on: Product[] = menu,
    ) {
      const result = processTurn(
        company,
        on,
        conversation,
        { messageId: `m${++n}`, text, now },
        actions,
        actions && response,
      );
      conversation = result.conversation;
      return result;
    },
  };
}
// "zinger deal aur burger": the Zinger Deal's drink waits behind "which burger?".
function waiting(text = 'zinger deal aur burger', quantity = 1) {
  const c = chat();
  const result = c.send(text, [add('zd', quantity), which(['zinger', 'chb'])]);
  expect(result.reply).toMatch(/^Which one would you like\?\n1\. .+\n2\. .+$/u);
  expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'zd', quantity });
  expect(c.conversation.pendingItemChoice?.candidateProductIds.sort()).toEqual(['chb', 'zinger']);
  return c;
}
const ASKS_DRINK = /Drink (?:chunein|منتخب)|Choose Drink/u;

describe('a deal waiting behind a dish’s "which one?", answered in the same message (finding 1)', () => {
  it('adds the deal once and never asks it again, whatever the AI lists first', () => {
    for (const actions of [
      [add('chb'), add('zd', 1, ['o-pepsi'])],
      [add('zd', 1, ['o-pepsi']), add('chb')],
    ]) {
      const c = waiting();
      const result = c.send('chicken wala, aur deal mein pepsi', actions);
      expect(result.reply).not.toMatch(ASKS_DRINK);
      expect(result.traces).toContain('deal_choice_answered');
      expect(result.traces).not.toContain('deal_choice_asked');
      expect(c.conversation.pendingDealChoice).toBeUndefined();
      expect(c.conversation.pendingItemChoice).toBeUndefined();
      expect(c.items.sort()).toEqual(['chb ×1', 'zd ×1 [o-pepsi]']);
      expect(result.reply).toContain('1 × Chicken Burger add kar diya');
      expect(result.reply).toContain('1 × Zinger Deal (Drink: Pepsi) add kar diya');
      // The customer's "pepsi" next is no answer to a question that was never asked again: no
      // second deal, whether the AI only answers or the bare-answer rule could have stepped in.
      c.send('pepsi', [{ type: 'answer', text: '' }], {
        text: 'Your Zinger Deal already has Pepsi. Anything else?',
        askFor: 'anything_else',
      });
      expect(c.items.sort()).toEqual(['chb ×1', 'zd ×1 [o-pepsi]']);
    }
    // Two of the deal, answered for both beside the dish.
    const two = waiting('2 zinger deal aur burger', 2);
    const both = two.send('chicken wala, dono deals mein pepsi', [
      add('chb'),
      add('zd', 2, ['o-pepsi']),
    ]);
    expect(both.reply).not.toMatch(ASKS_DRINK);
    expect(two.items).toEqual(['chb ×1', 'zd ×2 [o-pepsi]']);
    expect(two.conversation.pendingDealChoice).toBeUndefined();
  });

  it('does not ask the drink of a deal turned down in the same message', () => {
    const c = waiting();
    const result = c.send('chicken wala, deal rehne dein', [add('chb'), remove('zd')]);
    expect(result.reply).toContain('Theek hai, Zinger Deal add nahi kiya.');
    expect(result.reply).not.toMatch(ASKS_DRINK);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    expect(c.items).toEqual(['chb ×1']);
  });

  it('keeps a first pick and asks only the next choice of a deal with two', () => {
    const c = chat();
    c.send('deal 6 aur burger', [add('d6'), which(['zinger', 'chb'])]);
    const result = c.send('chicken wala, deal mein pepsi', [add('chb'), add('d6', 1, ['o-pepsi'])]);
    expect(result.reply).toContain('Deal 6 ke liye Side chunein:\n1. Fries\n2. Wings (+Rs. 100)');
    expect(result.reply).not.toContain('Phir agli deal batayein.');
    expect(c.conversation.pendingDealChoice).toMatchObject({
      productId: 'd6',
      picked: ['o-pepsi'],
    });
    c.send('fries', [add('d6', 1, ['o-fries'])]);
    expect(c.items).toEqual(['chb ×1', 'd6 ×1 [o-fries, o-pepsi]']);
  });

  it('asks the waiting deal once the dish is answered, on local rules too', () => {
    const c = chat();
    c.send('zinger deal aur burger');
    expect(c.conversation.pendingDealChoice?.productId).toBe('zd');
    const answered = c.send('chicken burger');
    expect(answered.reply).toBe(
      'Added 1 × Chicken Burger. Add anything else, or send “review”.\n\nChoose Drink for Zinger Deal:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)',
    );
    c.send('pepsi');
    expect(c.items).toEqual(['chb ×1', 'zd ×1 [o-pepsi]']);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
  });
});

describe('a deal’s count beside a dish answering "which one?" (finding 2)', () => {
  const cases: [string, number, string, BotAction[], string][] = [
    ['burger', 1, '3 burger deals, aur ek chicken burger', [add('bd', 3), add('chb')], 'chb ×1'],
    [
      'burger',
      1,
      '4 zinger deal pepsi wali, aur ek zinger burger',
      [add('zd', 4, ['o-pepsi']), add('zinger')],
      'zinger ×1',
    ],
    ['burger', 1, '2 zinger deal aur zinger burger', [add('zd', 2), add('zinger')], 'zinger ×1'],
    ['2 burger', 2, 'ek zinger deal aur zinger wale', [add('zd'), add('zinger', 2)], 'zinger ×2'],
    // A count written with the dish, or the deal's after the answer, stays as it was.
    ['burger', 1, 'zinger wala, aur 2 zinger deal', [add('zinger'), add('zd', 2)], 'zinger ×1'],
    ['burger', 1, 'zinger, 2 zinger deal', [add('zinger'), add('zd', 2)], 'zinger ×1'],
    ['burger', 1, '3 zinger burger aur zinger deal', [add('zinger', 3), add('zd')], 'zinger ×3'],
  ];

  it.each(cases)(
    'after “%s” (×%i), keeps the AI’s dish count for “%s”',
    (first, quantity, text, actions, dishLine) => {
      const c = chat();
      c.send(first, [which(['zinger', 'chb'], quantity)]);
      c.send(text, actions);
      expect(c.items.filter((line) => !/^(?:zd|bd) /u.test(line))).toEqual([dishLine]);
    },
  );

  it.each(cases)(
    'after “%s” (×%i), reads the dish’s count for “%s” on local rules',
    (first, quantity, text, _actions, dishLine) => {
      const c = chat();
      c.send(first, [which(['zinger', 'chb'], quantity)]);
      const [id, count] = dishLine.split(' ×');
      expect(parseActions(company, products, c.conversation, text)[0]).toMatchObject({
        type: 'add_item',
        productId: id,
        quantity: Number(count),
      });
    },
  );
});

describe('a deal waiting behind a "which deal?" list (finding 3)', () => {
  it('asks the waiting deal first when the deal chosen also needs a choice', () => {
    for (const actions of [[add('c2')], undefined]) {
      const c = chat();
      c.send('deal 1 aur ek combo', [add('d1'), which(['c1', 'c2', 'c3'])]);
      expect(c.conversation.pendingDealChoice?.productId).toBe('d1');
      const result = c.send('2', actions);
      expect(result.reply).toContain(
        'Choose Drink for Deal 1:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)\n\nThen tell me the next deal.',
      );
      expect(c.conversation.pendingDealChoice?.productId).toBe('d1');
      expect(c.conversation.pendingItemChoice).toBeUndefined();
      c.send('pepsi', actions && [add('d1', 1, ['o-pepsi'])]);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]']);
      c.send('combo 2 with 7up', actions && [add('c2', 1, ['o-7up'])]);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]', 'c2 ×1 [o-7up]']);
    }
    // The same where the list is of a dish and a deal named like it.
    const named = chat();
    named.send('deal 1 aur ek zinger', [add('d1'), which(['zinger', 'zd'])]);
    expect(named.send('zinger deal', [add('zd')]).reply).toContain(
      'Choose Drink for Deal 1:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)\n\nThen tell me the next deal.',
    );
    expect(named.conversation.pendingDealChoice?.productId).toBe('d1');
  });

  it('adds a deal chosen with nothing to choose, then asks the waiting one', () => {
    const c = chat();
    c.send('deal 1 aur ek combo', [add('d1'), which(['c1', 'c2', 'c3'])]);
    const result = c.send('1', [add('c1')]);
    expect(result.reply).toContain('Choose Drink for Deal 1:');
    expect(result.reply).not.toContain('Then tell me the next deal.');
    expect(c.items).toEqual(['c1 ×1']);
    expect(c.conversation.pendingDealChoice?.productId).toBe('d1');
  });
});

describe('the deal’s earlier picks and notes when the AI lists another item first (finding 4)', () => {
  it('keeps the first pick for a deal with two choices', () => {
    const c = chat();
    c.send('deal 6', [add('d6')]);
    c.send('pepsi', [add('d6', 1, ['o-pepsi'])]);
    const result = c.send('2 zinger burger bhi, aur side mein fries', [
      add('zinger', 2),
      add('d6', 1, ['o-fries']),
    ]);
    expect(result.reply).toContain('Added 1 × Deal 6 (Drink: Pepsi, Side: Fries)');
    expect(result.reply).not.toContain('Choose');
    expect(c.items).toEqual(['zinger ×2', 'd6 ×1 [o-fries, o-pepsi]']);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    // Drink 1, then Drink 2 beside water.
    const five = chat();
    five.send('deal 5', [add('d5')]);
    five.send('pepsi', [add('d5', 1, ['o-pepsi-1'])]);
    five.send('ek pani bhi aur doosri 7up', [add('water'), add('d5', 1, ['o-7up-2'])]);
    expect(five.items).toEqual(['water ×1', 'd5 ×1 [o-7up-2, o-pepsi-1]']);
  });

  it('keeps the deal’s notes', () => {
    const c = chat();
    c.send('2 deal 1, extra ketchup', [add('d1', 2, [], 'extra ketchup')]);
    c.send('ek pani bhi, aur pepsi', [add('water'), add('d1', 2, ['o-pepsi'])]);
    expect(c.items).toEqual(['water ×1', 'd1 ×2 [o-pepsi] "extra ketchup"']);
  });

  it('still sets aside a deal asked before when only something else is added', () => {
    const c = chat();
    c.send('deal 1', [add('d1')]);
    c.send('bas pani de dein', [add('water')]);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    expect(c.items).toEqual(['water ×1']);
  });
});

describe('the deal’s picks said back on the AI path in every language (finding 5)', () => {
  it('names the pick in Roman Urdu, Urdu and English', () => {
    expect(chat().send('deal 1 pepsi ke sath chahiye', [add('d1', 1, ['o-pepsi'])]).reply).toBe(
      '1 × Deal 1 (Drink: Pepsi) add kar diya — Rs. 610 each.\nItems subtotal: Rs. 610.\n\nAnything else?',
    );
    expect(chat().send('ڈیل 1 پیپسی کے ساتھ چاہیے', [add('d1', 1, ['o-pepsi'])]).reply).toContain(
      '1 × Deal 1 (Drink: Pepsi) شامل کر دیا — فی عدد Rs. 610۔',
    );
    expect(chat().send('deal 1 with pepsi please', [add('d1', 1, ['o-pepsi'])]).reply).toContain(
      'Added 1 × Deal 1 (Drink: Pepsi) — Rs. 610 each.',
    );
  });

  it('says a dish as before deals, without its size, in Roman Urdu', () => {
    const fries: Product = {
      ...dish('fries', 'Fries', [], 25000),
      variants: [
        { id: 'v-reg', name: 'Regular', price: 25000 },
        { id: 'v-lg', name: 'Large', price: 40000 },
      ],
    };
    for (const menu of [
      [...dishes, fries],
      [...products, fries],
    ]) {
      const result = chat(menu).send('large fries chahiye', [
        { type: 'add_item', productId: 'fries', quantity: 1, variantId: 'v-lg', modifierIds: [] },
      ]);
      expect(result.reply).toBe(
        '1 × Fries add kar diya — Rs. 400 each.\nItems subtotal: Rs. 400.\n\nAnything else?',
      );
    }
  });
});

describe('one question at a time', () => {
  it('asks a waiting deal once the "which one?" is passed over for another item', () => {
    const ai = waiting();
    const result = ai.send('pani bhi', [add('water')]);
    expect(result.reply).toContain('Choose Drink for Zinger Deal:');
    expect(ai.conversation.pendingItemChoice).toBeUndefined();
    expect(ai.conversation.pendingDealChoice?.productId).toBe('zd');
    const local = chat();
    local.send('zinger deal aur burger');
    expect(local.send('1 mineral water').reply).toBe(
      'Added 1 × Mineral Water. Add anything else, or send “review”.\n\nChoose Drink for Zinger Deal:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)',
    );
    // Asked once: passed over again, it is set aside.
    local.send('1 mineral water');
    expect(local.conversation.pendingDealChoice).toBeUndefined();
    expect(local.items).toEqual(['water ×2']);
  });

  it('keeps the deal waiting while the "which one?" is still open', () => {
    const c = waiting();
    c.send('kitni der lagegi?', [{ type: 'answer', text: '' }], {
      text: 'About 20 minutes.',
      askFor: 'none',
    });
    expect(c.conversation.pendingDealChoice?.productId).toBe('zd');
    expect(c.conversation.pendingItemChoice).toBeDefined();
  });

  it('closes an older "which one?" when a deal’s choice is asked, so a number answers the deal', () => {
    const c = chat();
    c.send('burger', [which(['zinger', 'chb'])]);
    expect(c.send('deal 1', [add('d1')]).reply).toContain('Choose Drink for Deal 1:');
    expect(c.conversation.pendingItemChoice).toBeUndefined();
    c.send('2');
    expect(c.items).toEqual(['d1 ×1 [o-7up]']);
  });
});

describe('one more of the open deal beside its answer, in any order (round 5, finding 1)', () => {
  const both = (first: BotAction, second: BotAction) => [
    [first, second],
    [second, first],
  ];

  it('adds the answered deal and asks the one more', () => {
    for (const actions of both(add('d1'), add('d1', 1, ['o-pepsi']))) {
      const c = chat();
      c.send('deal 1 please', [add('d1')]);
      const result = c.send('add one more deal 1, and pepsi for the first', actions);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]']);
      expect(result.reply).toContain('Added 1 × Deal 1 (Drink: Pepsi)');
      expect(result.reply).toContain('Choose Drink for Deal 1:\n1. Pepsi');
      expect(c.conversation.pendingDealChoice).toMatchObject({
        productId: 'd1',
        quantity: 1,
        picked: [],
      });
    }
  });

  it('asks the next choice of the answered deal, then the next deal, for a deal with two', () => {
    for (const actions of both(add('d6'), add('d6', 1, ['o-pepsi']))) {
      const c = chat();
      c.send('deal 6 please', [add('d6')]);
      const result = c.send('one more deal 6, and pepsi for the first', actions);
      expect(result.reply).toContain(
        'Choose Side for Deal 6:\n1. Fries\n2. Wings (+Rs. 100)\n\nThen tell me the next deal.',
      );
      expect(c.conversation.pendingDealChoice).toMatchObject({
        productId: 'd6',
        quantity: 1,
        picked: ['o-pepsi'],
      });
      expect(c.items).toEqual([]);
    }
  });

  it('keeps the third deal of "one more" beside an answer for two', () => {
    for (const actions of both(add('d1'), add('d1', 2, ['o-pepsi']))) {
      const c = chat();
      c.send('2 deal 1', [add('d1', 2)]);
      const result = c.send('ek aur deal 1 bhi chahiye, aur dono mein pepsi', actions);
      expect(c.items).toEqual(['d1 ×2 [o-pepsi]']);
      expect(result.reply).toMatch(ASKS_DRINK);
      expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', quantity: 1 });
    }
  });

  it('does the same for a deal waiting behind a dish’s "which one?"', () => {
    for (const actions of [
      [add('chb'), add('zd'), add('zd', 1, ['o-pepsi'])],
      [add('zd', 1, ['o-pepsi']), add('zd'), add('chb')],
    ]) {
      const c = waiting();
      const result = c.send('chicken wala, aur ek aur zinger deal, pehli mein pepsi', actions);
      expect(c.items.sort()).toEqual(['chb ×1', 'zd ×1 [o-pepsi]']);
      expect(result.reply).toContain('Zinger Deal ke liye Drink chunein:');
      expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'zd', picked: [] });
      expect(c.conversation.pendingItemChoice).toBeUndefined();
    }
  });
});

describe('a deal not added while another waits behind "which one?" (round 5, finding 2)', () => {
  const NEXT_DEAL = /Then tell me the next deal\.|Phir agli deal batayein\./u;

  it('says "Then tell me the next deal." once the waiting deal is asked', () => {
    const c = chat(wider);
    const first = c.send('deal 1, deal 3 aur ek burger', [
      add('d1'),
      add('d3'),
      which(['zinger', 'chb']),
    ]);
    expect(first.reply).toMatch(/^Which one would you like\?\n1\. .+\n2\. .+$/u);
    expect(c.conversation.pendingDealChoice?.productId).toBe('d1');
    const asked = c.send('chicken', [add('chb')]);
    expect(asked.reply).toContain(
      'Choose Drink for Deal 1:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)\n\nThen tell me the next deal.',
    );
    expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', picked: [] });
    expect(c.conversation.pendingDealChoice?.more).toBeUndefined();
    // Said once.
    const answered = c.send('pepsi', [add('d1', 1, ['o-pepsi'])]);
    expect(answered.reply).not.toMatch(NEXT_DEAL);
    expect(c.items).toEqual(['chb ×1', 'd1 ×1 [o-pepsi]']);
  });

  it('says it on local rules too', () => {
    const c = chat(wider);
    c.send('deal 1, deal 3 aur ek burger');
    expect(c.send('chicken burger').reply).toBe(
      'Added 1 × Chicken Burger. Add anything else, or send “review”.\n\nChoose Drink for Deal 1:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)\n\nThen tell me the next deal.',
    );
  });

  it('says it when the waiting deal is answered beside the dish', () => {
    const c = chat(wider);
    c.send('deal 1 and deal 3 and a burger', [add('d1'), add('d3'), which(['zinger', 'chb'])]);
    const result = c.send('chicken, and deal 1 with pepsi', [
      add('chb'),
      add('d1', 1, ['o-pepsi']),
    ]);
    expect(result.reply).toContain('Then tell me the next deal.');
    expect(result.reply).not.toMatch(ASKS_DRINK);
    expect(c.items).toEqual(['chb ×1', 'd1 ×1 [o-pepsi]']);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
  });
});

describe('a split answer for an open deal of two (round 5, finding 3)', () => {
  it('keeps the deal’s notes on every line, in any order', () => {
    for (const actions of [
      [add('d1', 1, ['o-pepsi']), add('d1', 1, ['o-7up'])],
      [add('d1', 1, ['o-7up']), add('d1', 1, ['o-pepsi'])],
    ]) {
      const c = chat();
      c.send('2 deal 1, mayo nahi', [add('d1', 2, [], 'no mayo')]);
      const result = c.send('ek pepsi aur ek 7up', actions);
      expect(c.items.sort()).toEqual(['d1 ×1 [o-7up] "no mayo"', 'd1 ×1 [o-pepsi] "no mayo"']);
      expect(result.reply).not.toMatch(ASKS_DRINK);
      expect(c.conversation.pendingDealChoice).toBeUndefined();
    }
  });

  it('keeps a first pick made for both on every line', () => {
    const c = chat();
    c.send('2 deal 6', [add('d6', 2)]);
    c.send('dono mein pepsi', [add('d6', 2, ['o-pepsi'])]);
    const result = c.send('ek mein fries ek mein wings', [
      add('d6', 1, ['o-fries']),
      add('d6', 1, ['o-wings']),
    ]);
    expect(c.items).toEqual(['d6 ×1 [o-fries, o-pepsi]', 'd6 ×1 [o-pepsi, o-wings]']);
    expect(result.reply).not.toContain('Choose');
    expect(c.conversation.pendingDealChoice).toBeUndefined();
  });

  it('gives a deal beyond the count asked none of them', () => {
    const c = chat();
    c.send('deal 6, mayo nahi', [add('d6', 1, [], 'no mayo')]);
    c.send('pepsi', [add('d6', 1, ['o-pepsi'])]);
    const result = c.send('fries, aur ek aur deal 6 wings ke sath', [
      add('d6', 1, ['o-fries']),
      add('d6', 1, ['o-wings']),
    ]);
    expect(c.items).toEqual(['d6 ×1 [o-fries, o-pepsi] "no mayo"']);
    expect(result.reply).toMatch(ASKS_DRINK);
    expect(c.conversation.pendingDealChoice).toMatchObject({
      productId: 'd6',
      quantity: 1,
      picked: ['o-wings'],
      notes: '',
    });
  });
});

describe('a bare answer to a dish’s "which one?" beside an open deal (round 5, finding 4)', () => {
  // "deal 1 aur ek pepsi": Pepsi 345ml or Pepsi 1.5L is asked, and Deal 1's drink waits.
  function sizes() {
    const c = chat(wider);
    c.send('deal 1 aur ek pepsi', [add('d1'), which(['pepsi', 'pepsi15'])]);
    expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', picked: [] });
    return c;
  }
  const stillWaits = (c: ReturnType<typeof chat>) => {
    expect(c.items).toEqual([]);
    expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', picked: [] });
    expect(c.conversation.pendingItemChoice?.candidateProductIds.sort()).toEqual([
      'pepsi',
      'pepsi15',
    ]);
  };

  // A turn while a deal's choice waits is about deals: the AI's reading of "pepsi" stands
  // (amendment v4, A5). Its size asked again keeps the deal waiting; its Pepsi 345ml answers the
  // size, and the deal's drink is asked next. Never the deal's drink.
  const sizedThenDrink = (
    c: ReturnType<typeof chat>,
    result: { reply: string; traces: string[] },
  ) => {
    expect(result.traces).not.toContain('deal_choice_resolved');
    expect(result.reply).toContain('Added 1 × Pepsi 345ml');
    expect(result.reply).toContain('Choose Drink for Deal 1:');
    expect(c.items).toEqual(['pepsi ×1']);
    expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', picked: [] });
    expect(c.conversation.pendingItemChoice).toBeUndefined();
  };

  it('reads "pepsi" as the which-one’s answer, not the deal’s drink', () => {
    const again = sizes();
    const result = again.send('pepsi', [which(['pepsi', 'pepsi15'])]);
    expect(result.reply).toMatch(/^Which one would you like\?/u);
    expect(result.traces).not.toContain('deal_choice_resolved');
    stillWaits(again);
    const sized = again.send('345ml', [add('pepsi')]);
    expect(again.items).toEqual(['pepsi ×1']);
    expect(sized.reply).toContain('Choose Drink for Deal 1:');
    const c = sizes();
    sizedThenDrink(c, c.send('pepsi', [add('pepsi')]));
  });

  it('does the same when the deal’s drink was asked before the size', () => {
    const c = chat(wider);
    c.send('deal 1', [add('d1')]);
    c.send('aur ek pepsi', [which(['pepsi', 'pepsi15'])]);
    sizedThenDrink(c, c.send('pepsi', [add('pepsi')]));
  });

  it('does the same on local rules', () => {
    const c = chat(wider);
    c.send('deal 1 aur ek pepsi');
    expect(parseActions(company, wider, c.conversation, 'pepsi')[0]).toMatchObject({
      type: 'clarify_item',
    });
    c.send('pepsi');
    stillWaits(c);
  });

  it('still takes "pepsi" as the drink while the "which one?" is about other dishes', () => {
    const c = chat(wider);
    c.send('deal 1', [add('d1')]);
    c.send('aur ek burger', [which(['zinger', 'chb'])]);
    const result = c.send('pepsi', [add('pepsi')]);
    expect(result.traces).toContain('deal_choice_resolved');
    expect(c.items).toEqual(['d1 ×1 [o-pepsi]']);
  });
});

describe('a count written after a deal, beside a dish answering "which one?" (round 5, finding 5)', () => {
  const cases: [string, number, string, BotAction[], string][] = [
    ['burger', 1, 'deal 4 x3 + chicken burger x1', [add('d4', 3), add('chb')], 'chb ×1'],
    ['burger', 1, 'deal 2 x2 + chicken burger', [add('d2', 2), add('chb')], 'chb ×1'],
    ['burger', 1, 'deal 2 x2 chicken burger x3', [add('d2', 2), add('chb', 3)], 'chb ×3'],
    [
      'burger',
      1,
      'deal 1 pepsi x2 + chicken burger x4',
      [add('d1', 2, ['o-pepsi']), add('chb', 4)],
      'chb ×4',
    ],
    ['burger', 1, 'deal 2 ×2 + chicken burger x3', [add('d2', 2), add('chb', 3)], 'chb ×3'],
    ['burger', 1, 'deal 2 2 + chicken burger 3', [add('d2', 2), add('chb', 3)], 'chb ×3'],
    ['2 burger', 2, 'deal 4 x3 + chicken', [add('d4', 3), add('chb', 2)], 'chb ×2'],
    // A number alone before the dish may be the dish's, and stays its.
    ['burger', 1, 'zinger deal 2 chicken burger', [add('zd'), add('chb', 2)], 'chb ×2'],
  ];
  const dishLines = (lines: string[]) => lines.filter((line) => !/^(?:d\d|zd) /u.test(line));

  it.each(cases)(
    'after “%s” (×%i), keeps the AI’s dish count for “%s”',
    (first, quantity, text, actions, dishLine) => {
      const c = chat(wider);
      c.send(first, [which(['zinger', 'chb'], quantity)]);
      c.send(text, actions);
      expect(dishLines(c.items)).toEqual([dishLine]);
    },
  );

  it.each(cases)(
    'after “%s” (×%i), reads the dish’s count for “%s” on local rules',
    (first, quantity, text, _actions, dishLine) => {
      const c = chat(wider);
      c.send(first, [which(['zinger', 'chb'], quantity)]);
      const [id, count] = dishLine.split(' ×');
      expect(parseActions(company, wider, c.conversation, text)[0]).toMatchObject({
        type: 'add_item',
        productId: id,
        quantity: Number(count),
      });
    },
  );

  it('keeps the AI’s "which burger?" for one, or its burger, with no "which one?" open', () => {
    const c = chat(wider);
    c.send('deal 2 x2 + burger', [add('d2', 2), which(['zinger', 'chb'])]);
    expect(c.items).toEqual(['d2 ×2']);
    expect(c.conversation.pendingItemChoice?.quantity).toBe(1);
    c.send('chicken', [add('chb')]);
    expect(c.items).toEqual(['d2 ×2', 'chb ×1']);
    // A turn naming a deal: the AI's burger stands (amendment v4, A5), never asked over.
    const ai = chat(wider);
    const result = ai.send('deal 2 x2 + burger', [add('d2', 2), add('chb')]);
    expect(result.traces).not.toContain('ambiguous_addition_prevented');
    expect(ai.items).toEqual(['d2 ×2', 'chb ×1']);
  });

  it('leaves a count on the next line to the dish there, on local rules', () => {
    for (const text of ['deal 4\nx2 chicken burger', 'deal 4\n(2) chicken burger']) {
      const open = chat(wider);
      open.send('burger', [which(['zinger', 'chb'])]);
      expect(parseActions(company, wider, open.conversation, text)[0]).toMatchObject({
        type: 'add_item',
        productId: 'chb',
        quantity: 2,
      });
      const none = chat(wider);
      none.send(text);
      expect(none.items).toEqual(['d4 ×1', 'chb ×2']);
    }
  });
});

// Amendment v4, Q: one question at a time, whatever order the AI lists its actions in.
describe('a dish’s "which one?" asked beside deals (amendment v4, Q)', () => {
  it('stays open when the AI lists an add after it', () => {
    for (const [answer, actions] of [
      ['Pepsi 1.5L', [add('pepsi15', 3)]],
      ['2', undefined],
    ] as [string, BotAction[] | undefined][]) {
      const c = chat(wider);
      const result = c.send('can I get 3 × pepsi, and 2 × deal 1 with Pepsi please', [
        which(['pepsi', 'pepsi15'], 3),
        add('d1', 2, ['o-pepsi']),
      ]);
      expect(result.reply).toMatch(
        /Which one would you like\?\n1\. Pepsi 345ml\n2\. Pepsi 1\.5L$/u,
      );
      expect(c.items).toEqual(['d1 ×2 [o-pepsi]']);
      expect(c.conversation.pendingItemChoice).toMatchObject({
        candidateProductIds: ['pepsi', 'pepsi15'],
        quantity: 3,
      });
      c.send(answer, actions);
      expect(c.items).toEqual(['d1 ×2 [o-pepsi]', 'pepsi15 ×3']);
    }
  });

  it('is asked alone, and the deal missing a choice after it, in any order', () => {
    const deal6 = add('d6', 1, ['o-7up']);
    const sizes = which(['pepsi', 'pepsi15'], 2);
    const deal1 = add('d1', 2, ['o-pepsi']);
    for (const actions of [
      [deal6, sizes, deal1],
      [sizes, deal6, deal1],
      [deal1, deal6, sizes],
    ]) {
      const c = chat(wider);
      const result = c.send('one deal 6 with 7up\n2x pepsi\ndeal 1 qty 2 with pepsi', actions);
      expect(result.reply).toMatch(
        /Which one would you like\?\n1\. Pepsi 345ml\n2\. Pepsi 1\.5L$/u,
      );
      expect(result.reply).not.toContain('Choose');
      expect(c.items).toEqual(['d1 ×2 [o-pepsi]']);
      expect(c.conversation.pendingItemChoice?.quantity).toBe(2);
      expect(c.conversation.pendingDealChoice).toMatchObject({
        productId: 'd6',
        picked: ['o-7up'],
      });
      // Once the size is answered, the deal is asked: never dropped.
      expect(c.send('Pepsi 345ml', [add('pepsi', 2)]).reply).toContain(
        'Choose Side for Deal 6:\n1. Fries\n2. Wings (+Rs. 100)',
      );
      c.send('fries', [add('d6', 1, ['o-fries'])]);
      expect(c.items).toEqual(['d1 ×2 [o-pepsi]', 'pepsi ×2', 'd6 ×1 [o-7up, o-fries]']);
    }
  });

  it('is asked alone beside one more of the open deal and its answer', () => {
    for (const actions of [
      [add('d1'), which(['zinger', 'chb']), add('d1', 1, ['o-pepsi'])],
      [which(['zinger', 'chb']), add('d1'), add('d1', 1, ['o-pepsi'])],
    ]) {
      const c = chat();
      c.send('deal 1 please', [add('d1')]);
      const result = c.send('ek burger aur ek aur deal 1, pehli mein pepsi', actions);
      expect(result.reply).toMatch(/Which one would you like\?\n1\. .+\n2\. .+$/u);
      expect(result.reply).not.toMatch(ASKS_DRINK);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]']);
      expect(c.conversation.pendingItemChoice).toBeDefined();
      expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', picked: [] });
      expect(c.send('chicken', [add('chb')]).reply).toMatch(ASKS_DRINK);
    }
  });
});

describe('the adds that answer the open deal (amendment v4, Q)', () => {
  const both = (first: BotAction, second: BotAction) => [
    [first, second],
    [second, first],
  ];

  it('answers it only with a choice it still has open, in any order', () => {
    // The other deal's drink names a choice the open deal has made: it is one more deal.
    for (const drinkId of ['o-pepsi', 'o-7up'])
      for (const actions of both(add('d6', 1, [drinkId]), add('d6', 1, ['o-fries']))) {
        const c = chat();
        c.send('deal 6', [add('d6')]);
        c.send('pepsi', [add('d6', 1, ['o-pepsi'])]);
        const result = c.send('ek aur deal 6, aur pehli mein fries', actions);
        // The first deal keeps its Pepsi; the other one is asked its side.
        expect(c.items).toEqual(['d6 ×1 [o-fries, o-pepsi]']);
        expect(result.reply).toMatch(/Choose Side for Deal 6:|Deal 6 ke liye Side chunein:/u);
        expect(c.conversation.pendingDealChoice).toMatchObject({
          productId: 'd6',
          picked: [drinkId],
        });
      }
    for (const actions of both(add('d5', 1, ['o-7up-1']), add('d5', 1, ['o-mirinda-2']))) {
      const c = chat();
      c.send('deal 5', [add('d5')]);
      c.send('pepsi', [add('d5', 1, ['o-pepsi-1'])]);
      c.send('ek aur deal 5 7up wali, pehli mein doosra mirinda', actions);
      expect(c.items).toEqual(['d5 ×1 [o-mirinda-2, o-pepsi-1]']);
      expect(c.conversation.pendingDealChoice).toMatchObject({
        productId: 'd5',
        picked: ['o-7up-1'],
      });
    }
  });

  it('adds one deal whose picks the AI split over two adds', () => {
    for (const actions of both(add('d6', 1, ['o-pepsi']), add('d6', 1, ['o-fries']))) {
      const c = chat();
      c.send('deal 6, mayo nahi', [add('d6', 1, [], 'no mayo')]);
      const result = c.send('pepsi aur fries', actions);
      expect(result.reply).not.toContain('Choose');
      expect(result.reply).not.toContain('Then tell me the next deal.');
      expect(c.items).toEqual(['d6 ×1 [o-fries, o-pepsi] "no mayo"']);
      expect(c.conversation.pendingDealChoice).toBeUndefined();
    }
    for (const actions of both(add('d6', 2, ['o-pepsi']), add('d6', 2, ['o-fries']))) {
      const c = chat();
      c.send('2 deal 6', [add('d6', 2)]);
      c.send('dono mein pepsi aur fries', actions);
      expect(c.items).toEqual(['d6 ×2 [o-fries, o-pepsi]']);
    }
    for (const actions of both(add('d5', 1, ['o-pepsi-1']), add('d5', 1, ['o-7up-2']))) {
      const c = chat();
      c.send('deal 5', [add('d5')]);
      c.send('pehli pepsi doosri 7up', actions);
      expect(c.items).toEqual(['d5 ×1 [o-7up-2, o-pepsi-1]']);
    }
  });

  it('gives an add naming no choice, within the count asked, its picks and notes', () => {
    for (const actions of both(add('d1', 1, ['o-pepsi']), add('d1'))) {
      const c = chat();
      c.send('2 deal 1, mayo nahi', [add('d1', 2, [], 'no mayo')]);
      c.send('ek mein pepsi, doosri ka baad mein', actions);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi] "no mayo"']);
      expect(c.conversation.pendingDealChoice).toMatchObject({
        productId: 'd1',
        quantity: 1,
        picked: [],
        notes: 'no mayo',
      });
      c.send('7up', [add('d1', 1, ['o-7up'])]);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi] "no mayo"', 'd1 ×1 [o-7up] "no mayo"']);
    }
    for (const actions of both(add('d6', 1, ['o-fries']), add('d6'))) {
      const c = chat();
      c.send('2 deal 6', [add('d6', 2)]);
      c.send('dono mein pepsi', [add('d6', 2, ['o-pepsi'])]);
      const result = c.send('ek mein fries, doosri ka baad mein', actions);
      expect(result.reply).toMatch(/Choose Side for Deal 6:|Deal 6 ke liye Side chunein:/u);
      expect(c.items).toEqual(['d6 ×1 [o-fries, o-pepsi]']);
      expect(c.conversation.pendingDealChoice).toMatchObject({ picked: ['o-pepsi'] });
    }
  });

  it('takes the answers that make up the count asked, whatever the AI lists first', () => {
    for (const actions of both(add('d1', 1, ['o-7up']), add('d1', 2, ['o-pepsi']))) {
      const c = chat();
      c.send('2 deal 1, mayo nahi', [add('d1', 2, [], 'no mayo')]);
      c.send('dono pepsi, aur ek aur deal 1 7up', actions);
      expect(c.items.sort()).toEqual(['d1 ×1 [o-7up]', 'd1 ×2 [o-pepsi] "no mayo"']);
    }
  });

  it('keeps its picks and notes when the answer never runs', () => {
    for (const actions of [
      [add('d6'), add('d6', 60, ['o-fries'])],
      [add('d6'), { type: 'handoff' } as BotAction, add('d6', 1, ['o-fries'])],
    ]) {
      const c = chat();
      c.send('deal 6, mayo nahi', [add('d6', 1, [], 'no mayo')]);
      c.send('pepsi', [add('d6', 1, ['o-pepsi'])]);
      c.send('fries, aur ek aur deal 6', actions);
      expect(c.items).toEqual([]);
      expect(c.conversation.pendingDealChoice).toMatchObject({
        productId: 'd6',
        picked: ['o-pepsi'],
        notes: 'no mayo',
      });
    }
    const c = chat();
    c.send('deal 6, mayo nahi', [add('d6', 1, [], 'no mayo')]);
    c.send('pepsi', [add('d6', 1, ['o-pepsi'])]);
    expect(c.send('fries, aur ek aur deal 6', [add('d6'), add('d6', 60, ['o-fries'])]).reply).toBe(
      'Choose a quantity between 1 and 50.\n\nChoose Side for Deal 6:\n1. Fries\n2. Wings (+Rs. 100)\n\nThen tell me the next deal.',
    );
    c.send('fries', [add('d6', 1, ['o-fries'])]);
    expect(c.items).toEqual(['d6 ×1 [o-fries, o-pepsi] "no mayo"']);
  });
});

describe('"Then tell me the next deal." for the deals not added (amendment v4, Q)', () => {
  const NEXT_DEAL = /Then tell me the next deal\.|Phir agli deal batayein\./u;
  // Deal 1 waits behind "which burger?", and Deal 3 was not added.
  function behind() {
    const c = chat(wider);
    c.send('deal 1, deal 3 aur ek burger', [add('d1'), add('d3'), which(['zinger', 'chb'])]);
    expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', more: ['d3'] });
    return c;
  }

  it('is not said once the deal not added is added or turned down', () => {
    for (const actions of [
      [add('chb'), add('d1', 1, ['o-pepsi']), add('d3', 1, ['o-pepsi'])],
      [add('d3', 1, ['o-pepsi']), add('d1', 1, ['o-pepsi']), add('chb')],
    ]) {
      const c = behind();
      const result = c.send('chicken wala, aur dono deals mein pepsi', actions);
      expect(result.reply).not.toMatch(NEXT_DEAL);
      expect(c.items.sort()).toEqual(['chb ×1', 'd1 ×1 [o-pepsi]', 'd3 ×1 [o-pepsi]']);
    }
    const c = behind();
    const result = c.send('chicken, deal 3 cancel kar do', [add('chb'), remove('d3')]);
    expect(result.reply).toMatch(ASKS_DRINK);
    expect(result.reply).not.toMatch(NEXT_DEAL);
    const added = behind();
    expect(added.send('chicken, deal 3 7up', [add('chb'), add('d3', 1, ['o-7up'])]).reply).toMatch(
      ASKS_DRINK,
    );
    expect(added.conversation.pendingDealChoice?.more).toBeUndefined();
    expect(added.send('pepsi', [add('d1', 1, ['o-pepsi'])]).reply).not.toMatch(NEXT_DEAL);
  });

  it('is said once when the waiting deal is turned down or deleted', () => {
    const declined = behind();
    const result = declined.send('chicken, deal 1 nahi chahiye', [add('chb'), remove('d1')]);
    expect(result.reply.match(new RegExp(NEXT_DEAL, 'gu'))).toHaveLength(1);
    expect(declined.conversation.pendingDealChoice).toBeUndefined();
    const deleted = behind();
    const gone = wider.filter((product) => product.id !== 'd1');
    const answered = deleted.send('chicken', [add('chb')], ok, gone);
    expect(answered.reply.match(new RegExp(NEXT_DEAL, 'gu'))).toHaveLength(1);
    expect(deleted.send('kuch aur?', [{ type: 'answer', text: '' }], ok, gone).reply).not.toMatch(
      NEXT_DEAL,
    );
  });
});

describe('a deal word beside the option while a size "which one?" is open (amendment v4, f4)', () => {
  it('answers the open deal on local rules and in the hint the AI gets', () => {
    for (const text of ['deal wali pepsi', 'deal mein pepsi', 'pepsi for the deal']) {
      const c = chat(wider);
      c.send('deal 1 aur ek pepsi');
      expect(c.conversation.pendingItemChoice).toBeDefined();
      expect(parseActions(company, wider, c.conversation, text)[0]).toMatchObject({
        type: 'add_item',
        productId: 'd1',
        modifierIds: ['o-pepsi'],
      });
      c.send(text);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]']);
      expect(c.conversation.pendingDealChoice).toBeUndefined();
    }
  });
});
