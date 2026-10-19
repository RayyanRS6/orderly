// Final review, fx-10 (conversation-1): on a menu where several dishes share an option word
// (Half/Full on karahi, biryani and daal is common), a count written between two dishes is still
// never counted for both, and never overrides the AI when the customer answers "which one?".
import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { clearQuantityNear } from '../src/domain/menu-resolver';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, Product } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const seed = seedProducts.filter((p) => p.companyId === company.id);
const named = (name: string) => seed.find((p) => p.name === name)!;
const karahi = named('Chicken Karahi');
const naan = named('Butter Naan');
const karahiHalf = karahi.variants.find((v) => v.name === 'Half')!;
let option = 0;
// The same dish sold as Half and Full, as the karahi is.
const halfAndFull = (product: Product): Product => ({
  ...product,
  variants: ['Half', 'Full'].map((name, index) => ({
    id: `44444444-4444-4444-a444-${String(++option).padStart(12, '0')}`,
    name,
    price: product.price * (index + 1),
  })),
});
const biryani = halfAndFull(named('Chicken Biryani'));
const daal = halfAndFull(named('Daal Makhani'));
const beef: Product = halfAndFull({
  ...named('Chicken Biryani'),
  id: '33333333-3333-4333-a333-0000000000b2',
  name: 'Beef Biryani',
  aliases: [],
  modifiers: [],
});
const catalog = seed.map((p) => (p.id === biryani.id ? biryani : p.id === daal.id ? daal : p));
const withBeef = [...catalog, beef];
const fresh = () => createConversation(company.id, '923000000171', 'demo', now);
const counts = (text: string) =>
  Object.fromEntries(
    parseActions(company, catalog, fresh(), text).flatMap((action) =>
      action.type === 'add_item' ? [[action.productId, action.quantity]] : [],
    ),
  );
const add = (product: Product, quantity: number, variantId?: string): BotAction => ({
  type: 'add_item',
  productId: product.id,
  quantity,
  ...(variantId && { variantId }),
});
const half = (product: Product) => product.variants.find((v) => v.name === 'Half')!.id;
let message = 0;
function answer(c: Conversation, text: string, actions: BotAction[]) {
  return processTurn(
    company,
    withBeef,
    c,
    { messageId: `fx10-quantity-${++message}`, text, now },
    actions,
    { text: 'Anything else?', askFor: 'anything_else' },
  );
}
const choosing = (candidates: Product[], quantity = 1) => {
  const c = fresh();
  c.pendingItemChoice = {
    candidateProductIds: candidates.map((p) => p.id),
    quantity,
    requestedOptionNames: [],
    notes: '',
    originalText: 'biryani',
  };
  return c;
};
const quantities = (c: Conversation) =>
  Object.fromEntries(c.cart.items.map((item) => [item.productId, item.quantity]));

describe('fx-10: an option word two dishes share stays with the dish before it', () => {
  it.each([
    ['karahi half 4 biryani', { [karahi.id]: 4, [biryani.id]: 1 }],
    ['karahi full 2 daal', { [karahi.id]: 2, [daal.id]: 1 }],
    ['biryani half 3 karahi', { [biryani.id]: 3, [karahi.id]: 1 }],
    // The readings the earlier fixes settled stay.
    ['karahi half 4 naan', { [karahi.id]: 4, [naan.id]: 1 }],
    ['2 half karahi 3 biryani', { [karahi.id]: 2, [biryani.id]: 3 }],
    ['3 biryani half aur 2 karahi', { [biryani.id]: 3, [karahi.id]: 2 }],
    ['karahi, 4 biryani', { [karahi.id]: 1, [biryani.id]: 4 }],
  ] as const)('“%s” never gives one number to two dishes', (text, expected) => {
    expect(counts(text)).toEqual(expected);
  });

  it('gives a count only to the dish it can only belong to', () => {
    expect(clearQuantityNear(biryani, 'karahi half 4 biryani', catalog)).toBeUndefined();
    expect(clearQuantityNear(biryani, 'karahi half 4 chicken wali half', withBeef)).toBeUndefined();
    expect(clearQuantityNear(biryani, '4 half biryani', catalog)).toBe(4);
    expect(clearQuantityNear(biryani, 'biryani half 4', catalog)).toBe(4);
    expect(clearQuantityNear(biryani, 'chicken wali half 3', withBeef)).toBe(3);
  });
});

describe('fx-10: answering “which biryani?” after a karahi with a shared option word', () => {
  it('keeps the AI’s 1 biryani and 4 karahi', () => {
    const result = answer(choosing([biryani, beef]), 'karahi half 4 chicken wali half', [
      add(karahi, 4, karahiHalf.id),
      add(biryani, 1, half(biryani)),
    ]);
    expect(quantities(result.conversation)).toEqual({ [karahi.id]: 4, [biryani.id]: 1 });
    expect(result.traces).toContain('item_choice_resolved');
  });

  it('still takes the customer’s own count for the chosen dish', () => {
    const result = answer(choosing([biryani, beef]), 'chicken wali half 3', [
      add(biryani, 1, half(biryani)),
    ]);
    expect(quantities(result.conversation)).toEqual({ [biryani.id]: 3 });
  });
});
