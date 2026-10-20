import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { sellableCatalog } from '../src/shared/deals';
import { seedCompanies } from '../src/shared/seed';
import type { BotAction, Deal, DealChoiceGroup, ModelResponse, Product } from '../src/shared/types';

// The AI's actions about deals stand on the AI path: the engine's own reading of the message
// (local rules) never replaces, drops, recounts or retargets them. Each case is a message that
// the engine reads wrongly (round-3 review findings 1-8), with the AI reading it right. Bun & Co.
// is open all day; Tuesday 20 October 2026 at 13:00 in Karachi.
const company = seedCompanies[1]!;
const now = '2026-10-20T08:00:00.000Z';
const dish = (id: string, name: string, aliases: string[] = []): Product => ({
  id,
  companyId: company.id,
  name,
  description: '',
  category: 'Drinks',
  price: 12000,
  available: true,
  emoji: '🥤',
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
  price: 60000,
  items: [{ name: 'Zinger burger', quantity: 1 }],
  choices,
  available: true,
  position,
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const products = sellableCatalog(
  company,
  [
    dish('pepsi', 'Pepsi 345ml', ['pepsi']),
    dish('pepsi-15', 'Pepsi 1.5L'),
    dish('7up', '7up 345ml', ['7up']),
    dish('zinger', 'Zinger Burger', ['zinger']),
  ],
  [
    deal('d1', 'Deal 1', 1, [drink]),
    deal('d2', 'Deal 2', 2),
    deal('d3', 'Deal 3', 3, [drink]),
    deal('d4', 'Deal 4', 4),
    deal('c1', 'Combo 1', 5),
    deal('c2', 'Combo 2', 6),
    deal('c3', 'Combo 3', 7),
    deal('s1', 'Student Deal 1', 8),
  ],
  now,
  { all: true },
);
const ok: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' };
const add = (productId: string, quantity = 1, modifierIds: string[] = []): BotAction => ({
  type: 'add_item',
  productId,
  quantity,
  modifierIds,
});
const remove = (productId: string): BotAction => ({ type: 'remove_item', productId });
function chat() {
  let conversation = createConversation(company.id, '923001234567', 'whatsapp', now);
  let n = 0;
  return {
    get conversation() {
      return conversation;
    },
    get items() {
      return conversation.cart.items.map(
        (item) =>
          `${item.productId} ×${item.quantity}${item.modifierIds.length ? ` [${item.modifierIds.join(', ')}]` : ''}`,
      );
    },
    send(text: string, actions: BotAction[]) {
      const result = processTurn(
        company,
        products,
        conversation,
        { messageId: `m${++n}`, text, now },
        actions,
        ok,
      );
      conversation = result.conversation;
      return result;
    },
  };
}
// The deal's drink asked about, for `quantity` of Deal 1.
function asked(quantity = 1) {
  const c = chat();
  c.send(quantity > 1 ? `${quantity} deal 1` : 'deal 1', [add('d1', quantity)]);
  expect(c.conversation.pendingDealChoice).toMatchObject({ productId: 'd1', quantity });
  return c;
}
const reads = (text: string) =>
  parseActions(company, products, createConversation(company.id, '9230', 'whatsapp', now), text);

describe('the AI’s deal actions stand where the engine reads the message wrongly', () => {
  it('keeps the AI’s Deal 2 for a deal word and number the engine reads as two deals (finding 1)', () => {
    for (const text of [
      'ڈیل 2 چاہیے',
      'ڈیل ۲ چاہیے',
      'deal no 2 chahiye',
      'deal number 2 de dein',
      'ڈیل نمبر 2 چاہیے',
      '2 number deal chahiye',
      'deals 2 chahiye',
    ]) {
      // On local rules the engine still asks "Deal 2 or Combo 2?".
      expect(reads(text)[0]).toMatchObject({ type: 'clarify_item' });
      const c = chat();
      const result = c.send(text, [add('d2')]);
      expect(result.traces).toEqual(['add_item']);
      expect(c.items).toEqual(['d2 ×1']);
      expect(c.conversation.pendingItemChoice).toBeUndefined();
    }
    // The AI's 2 × Deal 3: its drink is asked for both, never "Deal 3 or Combo 3?".
    const c = chat();
    expect(c.send('2 ڈیل 3 چاہیے', [add('d3', 2)]).reply).toBe(
      '2 × Deal 3 کے لیے Drink منتخب کریں:\n1. Pepsi\n2. 7up\n3. Mirinda (+Rs. 50)',
    );
    expect(c.conversation.pendingItemChoice).toBeUndefined();
  });

  it('keeps the AI’s drink, not the deal, when the deal is turned down beside it (finding 2)', () => {
    for (const text of [
      'no deal, only pepsi',
      'deal nahi, bas pepsi',
      'deal rehne dein, sirf pepsi bhej dein',
      'deal cancel karo, just pepsi',
      'deal ki jagah sirf pepsi de dein',
    ])
      for (const actions of [
        [add('pepsi')],
        [remove('d1'), add('pepsi')],
        [add('pepsi'), remove('d1')],
      ]) {
        const c = asked();
        const result = c.send(text, actions);
        expect(result.traces).not.toContain('validation_failed:remove_item');
        expect(c.items).toEqual(['pepsi ×1']);
        expect(c.conversation.pendingDealChoice).toBeUndefined();
      }
    // A Deal 1 in the cart stays when the second one asked about is turned down.
    const c = chat();
    c.send('deal 1 with 7up', [add('d1', 1, ['o-7up'])]);
    c.send('ek aur deal 1', [add('d1')]);
    c.send('deal rehne dein, sirf pepsi', [add('pepsi'), remove('d1')]);
    expect(c.items).toEqual(['d1 ×1 [o-7up]', 'pepsi ×1']);
    // The dish ordered beside the refusal is kept, with the AI's drink.
    const beside = asked();
    beside.send('deal 1 nahi, zinger burger aur pepsi', [add('zinger'), add('pepsi')]);
    expect(beside.items).toEqual(['zinger ×1', 'pepsi ×1']);
  });

  it('keeps the AI’s split of a deal asked for more than once between drinks (finding 3)', () => {
    for (const [count, text, actions, cart] of [
      [
        2,
        'pepsi aur 7up',
        [add('d1', 1, ['o-pepsi']), add('d1', 1, ['o-7up'])],
        ['d1 ×1 [o-pepsi]', 'd1 ×1 [o-7up]'],
      ],
      [
        2,
        'aik pepsi aur doosri 7up',
        [add('d1', 1, ['o-pepsi']), add('d1', 1, ['o-7up'])],
        ['d1 ×1 [o-pepsi]', 'd1 ×1 [o-7up]'],
      ],
      [
        2,
        'پیپسی اور سیون اپ',
        [add('d1', 1, ['o-pepsi']), add('d1', 1, ['o-7up'])],
        ['d1 ×1 [o-pepsi]', 'd1 ×1 [o-7up]'],
      ],
      [
        3,
        'do pepsi aur aik 7up',
        [add('d1', 2, ['o-pepsi']), add('d1', 1, ['o-7up'])],
        ['d1 ×2 [o-pepsi]', 'd1 ×1 [o-7up]'],
      ],
      [
        2,
        'pepsi and mirinda',
        [add('d1', 1, ['o-pepsi']), add('d1', 1, ['o-mirinda'])],
        ['d1 ×1 [o-pepsi]', 'd1 ×1 [o-mirinda]'],
      ],
    ] as [number, string, BotAction[], string[]][]) {
      const c = asked(count);
      c.send(text, actions);
      expect(c.items).toEqual(cart);
      expect(c.conversation.pendingDealChoice).toBeUndefined();
    }
  });

  it('keeps the answer and another of the same deal with its own drink (finding 4)', () => {
    for (const [text, second] of [
      ['pepsi, aur ek aur deal 1 7up ke sath', 'o-7up'],
      ['Pepsi. Also add another Deal 1 with Mirinda', 'o-mirinda'],
    ]) {
      const c = asked();
      c.send(text!, [add('d1', 1, ['o-pepsi']), add('d1', 1, [second!])]);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]', `d1 ×1 [${second}]`]);
    }
    const two = asked(2);
    two.send('dono pepsi wali. aur 1 deal 1 mirinda wali bhi', [
      add('d1', 2, ['o-pepsi']),
      add('d1', 1, ['o-mirinda']),
    ]);
    expect(two.items).toEqual(['d1 ×2 [o-pepsi]', 'd1 ×1 [o-mirinda]']);
  });

  it('keeps a bigger bottle of the answer’s drink ordered beside it (finding 5)', () => {
    for (const text of [
      'pepsi, aur ek 1.5 litre pepsi bhi',
      'pepsi. ek bari pepsi bhi bhej dein',
      'pepsi, aur ghar ke liye 1.5 wali pepsi',
    ]) {
      const c = asked();
      c.send(text, [add('d1', 1, ['o-pepsi']), add('pepsi-15')]);
      expect(c.items).toEqual(['d1 ×1 [o-pepsi]', 'pepsi-15 ×1']);
    }
  });

  it('keeps a deal ordered with a count or a pick beside a question about other deals (finding 6)', () => {
    for (const [text, action, cart] of [
      ['2 deal 2, aur koi deal hai?', add('d2', 2), 'd2 ×2'],
      ['deal 4 x2. aur koi deal hai kya?', add('d4', 2), 'd4 ×2'],
      ['۲ ڈیل ۴، کوئی اور ڈیل ہے؟', add('d4', 2), 'd4 ×2'],
      ['2 deal 1 pepsi wali, aur koi offer hai?', add('d1', 2, ['o-pepsi']), 'd1 ×2 [o-pepsi]'],
      ['deal 4 x2. deal 3 kitne ki hai?', add('d4', 2), 'd4 ×2'],
    ] as [string, BotAction, string][]) {
      // On local rules the engine shows a deal instead.
      expect(reads(text)[0]).toMatchObject({ type: 'menu' });
      const c = chat();
      const result = c.send(text, [action]);
      expect(result.traces).not.toContain('browse_cart_mutation_prevented');
      expect(c.items).toEqual([cart]);
    }
  });

  it('keeps the AI’s count for a deal written as "2x3" (finding 7)', () => {
    for (const [text, id, count] of [
      ['deal 2x3 chahiye', 'd2', 3],
      ['deal 4x2 de dein', 'd4', 2],
      ['i want deal 2x2', 'd2', 2],
    ] as const) {
      expect(reads(text)[0]).toMatchObject({ type: 'clarify_item' });
      const c = chat();
      const result = c.send(text, [add(id, count)]);
      expect(result.traces).toEqual(['add_item']);
      expect(c.items).toEqual([`${id} ×${count}`]);
    }
  });

  it('keeps the AI’s count written with ×, * or brackets, also while the drink is asked (finding 8)', () => {
    for (const text of ['deal 4 ×2', 'deal 4*2', 'deal 4 (2)', 'Deal 4 - 2']) {
      const c = chat();
      c.send(text, [add('d4', 2)]);
      expect(c.items).toEqual(['d4 ×2']);
    }
    for (const text of [
      'pepsi, deal 1 ×2',
      'pepsi, deal 1 *2',
      'deal 1 ×2 pepsi',
      'deal 1 (2) pepsi',
    ]) {
      const c = asked();
      const result = c.send(text, [add('d1', 2, ['o-pepsi'])]);
      expect(result.traces).not.toContain('deal_choice_asked');
      expect(c.items).toEqual(['d1 ×2 [o-pepsi]']);
    }
  });
});
