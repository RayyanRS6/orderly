import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import {
  quantityAfter,
  quantityBefore,
  quantityOfMention,
  resolveItemMention,
} from '../src/domain/menu-resolver';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, ModelResponse, Product } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const tikka = products.find((p) => p.name === 'Chicken Tikka')!;
const naan = products.find((p) => p.name === 'Butter Naan')!;
const beef: Product = {
  ...biryani,
  id: '33333333-3333-4333-a333-0000000000b1',
  name: 'Beef Biryani',
  aliases: [],
  variants: [],
  modifiers: [],
};
const biryanis = [...products, beef];
const fresh = () => createConversation(company.id, '923000000091', 'demo', now);
let message = 0;
function turn(
  c: Conversation,
  text: string,
  options: { actions?: BotAction[]; response?: ModelResponse; catalog?: Product[] } = {},
) {
  return processTurn(
    company,
    options.catalog ?? biryanis,
    c,
    { messageId: `fx1-quantity-${++message}`, text, now },
    options.actions,
    options.response,
  );
}
const model = (text = 'Anything else?'): ModelResponse => ({ text, askFor: 'anything_else' });
const add = (product: Product, quantity: number): BotAction => ({
  type: 'add_item',
  productId: product.id,
  quantity,
});
const pendingFor = (quantity = 1) => {
  const c = fresh();
  c.pendingItemChoice = {
    candidateProductIds: [biryani.id, beef.id],
    quantity,
    requestedOptionNames: [],
    notes: '',
    originalText: 'biryani',
  };
  return c;
};
const quantities = (c: Conversation) =>
  Object.fromEntries(c.cart.items.map((item) => [item.productId, item.quantity]));

describe('F08: a count next to another item never becomes the chosen dish’s count', () => {
  it.each([
    ['naan 3, chicken wali', [add(biryani, 1), add(naan, 3)], { [biryani.id]: 1, [naan.id]: 3 }],
    [
      'tikka 2, chicken wali bhi',
      [add(biryani, 1), add(tikka, 2)],
      { [biryani.id]: 1, [tikka.id]: 2 },
    ],
    ['naan 3, chicken wali 2', [add(biryani, 2), add(naan, 3)], { [biryani.id]: 2, [naan.id]: 3 }],
    [
      'naan 4\nchicken biryani 1',
      [add(biryani, 1), add(naan, 4)],
      { [biryani.id]: 1, [naan.id]: 4 },
    ],
    [
      'naan 3 chicken biryani 2',
      [add(biryani, 2), add(naan, 3)],
      { [biryani.id]: 2, [naan.id]: 3 },
    ],
  ] as const)('“%s” answers “which one?” with the AI’s counts', (text, actions, expected) => {
    const result = turn(pendingFor(1), text, { actions: [...actions], response: model() });
    expect(quantities(result.conversation)).toEqual(expected);
    expect(result.traces).toContain('item_choice_resolved');
  });

  it('keeps the pending count when only the local rules read the message', () => {
    for (const text of ['naan 3 chicken wali', 'naan 3, chicken wali', 'bhej do chicken wali']) {
      expect(parseActions(company, biryanis, pendingFor(1), text)[0], text).toMatchObject({
        type: 'add_item',
        productId: biryani.id,
        quantity: 1,
      });
    }
    // The customer's own count for the dish still counts, before or after it.
    expect(
      parseActions(company, biryanis, pendingFor(1), 'naan 3, 2 chicken wali')[0],
    ).toMatchObject({ productId: biryani.id, quantity: 2 });
    expect(parseActions(company, biryanis, pendingFor(1), 'chicken wali 3')[0]).toMatchObject({
      productId: biryani.id,
      quantity: 3,
    });
    expect(parseActions(company, biryanis, pendingFor(2), 'do chicken wali')[0]).toMatchObject({
      quantity: 2,
    });
  });
});

describe('F08: an address, area or time number is never the count of a dish to choose', () => {
  it.each([
    'biryani bhej do DHA phase 5',
    'biryani, delivery, house 12 street 4',
    'biryani bhejo gulberg 3',
    'biryani 8 baje tak',
    'biryani teen baje tak bhej dein',
    'johar town block 4 biryani',
  ])('asks which one for 1 on “%s”', (text) => {
    expect(parseActions(company, biryanis, fresh(), text)[0]).toMatchObject({
      type: 'clarify_item',
      quantity: 1,
    });
  });

  it.each([
    ['2 biryani', 2],
    ['biryani 2', 2],
    ['biryani x2', 2],
    ['biryani 3 plate', 3],
    ['biryani, make it 3', 3],
    ['mujhe do biryani chahiye', 2],
    ['biryani 2 de do', 2],
  ] as const)('keeps the count written next to the dish: “%s”', (text, quantity) => {
    expect(parseActions(company, biryanis, fresh(), text)[0]).toMatchObject({
      type: 'clarify_item',
      quantity,
    });
    expect(resolveItemMention(biryanis, company.id, text).quantity).toBe(quantity);
  });

  it('adds 1 after “which one?” for an address number, whatever the AI first proposed', () => {
    const asked = turn(fresh(), 'biryani bhej do DHA phase 5', {
      actions: [add(biryani, 1)],
      response: model('Which one?'),
    });
    expect(asked.traces).toContain('ambiguous_addition_prevented');
    expect(asked.conversation.pendingItemChoice?.quantity).toBe(1);
    const picked = turn(asked.conversation, 'chicken wali', {
      actions: [add(biryani, 1)],
      response: model(),
    });
    expect(quantities(picked.conversation)).toEqual({ [biryani.id]: 1 });
    expect(picked.reply).toContain('Added 1 × Chicken Biryani');
  });
});

describe('F08: the local rules give each named dish its own count', () => {
  const counts = (text: string) =>
    Object.fromEntries(
      parseActions(company, products, fresh(), text).flatMap((action) =>
        action.type === 'add_item' ? [[action.productId, action.quantity]] : [],
      ),
    );

  it.each([
    ['naan 3, chicken biryani', { [naan.id]: 3, [biryani.id]: 1 }],
    ['naan 3 chicken biryani', { [naan.id]: 3, [biryani.id]: 1 }],
    ['3 naan 2 chicken biryani', { [naan.id]: 3, [biryani.id]: 2 }],
    ['2 chicken biryani aur 1 chicken tikka', { [biryani.id]: 2, [tikka.id]: 1 }],
    ['chicken biryani 2, naan 4', { [biryani.id]: 2, [naan.id]: 4 }],
    ['chicken biryani, house 12 street 4', { [biryani.id]: 1 }],
    ['street 4 house 12 chicken biryani', { [biryani.id]: 1 }],
    ['bhej do chicken biryani', { [biryani.id]: 1 }],
    ['2 chicken biryani and 3 naan', { [biryani.id]: 2, [naan.id]: 3 }],
    ['ek chicken biryani', { [biryani.id]: 1 }],
    ['teen chicken biryani', { [biryani.id]: 3 }],
  ] as const)('“%s”', (text, expected) => {
    expect(counts(text)).toEqual(expected);
  });

  it('still refuses a count above 50 instead of changing it', () => {
    const result = turn(fresh(), '60 chicken biryani', { catalog: products });
    expect(result.conversation.cart.items).toEqual([]);
    expect(result.reply).toBe('Choose a quantity between 1 and 50.');
  });

  it('exposes the count helpers', () => {
    expect(quantityBefore(biryani, 'naan 3 chicken biryani', products)).toBeUndefined();
    expect(quantityBefore(biryani, '3 naan 2 chicken biryani', products)).toBe(2);
    expect(quantityBefore(biryani, 'naan 3, chicken biryani', products)).toBeUndefined();
    expect(quantityAfter(biryani, 'chicken biryani 3', products)).toBe(3);
    expect(quantityAfter(biryani, 'chicken biryani 5 minute mein', products)).toBeUndefined();
    expect(quantityAfter(biryani, 'chicken biryani do', products)).toBeUndefined();
    expect(quantityOfMention(naan, 'naan', 'naan 3 chicken biryani', products)).toBe(3);
    expect(
      quantityOfMention(tikka, 'chicken tikka', '2 chicken biryani aur 1 chicken tikka', products),
    ).toBe(1);
  });
});
