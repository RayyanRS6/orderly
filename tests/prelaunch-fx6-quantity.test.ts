// Final review, fx-6 (conversation-1): a count written between two dishes with no comma or "aur"
// ("karahi 4 naan", "chicken wali 4 naan") never counts for two dishes, never overrides the AI's
// reading when the customer answers "which one?", and is never the count of a dish to choose.
import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { clearQuantityNear, quantityOfMention } from '../src/domain/menu-resolver';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, ModelResponse, Product } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const karahi = products.find((p) => p.name === 'Chicken Karahi')!;
const tikka = products.find((p) => p.name === 'Chicken Tikka')!;
const naan = products.find((p) => p.name === 'Butter Naan')!;
const lassi = products.find((p) => p.name === 'Mango Lassi')!;
const half = karahi.variants.find((v) => v.name === 'Half')!;
const mutton: Product = {
  ...karahi,
  id: '33333333-3333-4333-a333-0000000000c1',
  name: 'Mutton Karahi',
  aliases: ['karahi', 'mutton karahi'],
  variants: [],
  modifiers: [],
};
const beef: Product = {
  ...biryani,
  id: '33333333-3333-4333-a333-0000000000b1',
  name: 'Beef Biryani',
  aliases: [],
  variants: [],
  modifiers: [],
};
const karahis = [...products, mutton];
const biryanis = [...products, beef];
const fresh = () => createConversation(company.id, '923000000161', 'demo', now);
let message = 0;
function turn(
  catalog: Product[],
  c: Conversation,
  text: string,
  actions?: BotAction[],
  response: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' },
) {
  return processTurn(
    company,
    catalog,
    c,
    { messageId: `fx6-quantity-${++message}`, text, now },
    actions,
    actions ? response : undefined,
  );
}
const add = (product: Product, quantity: number, variantId?: string): BotAction => ({
  type: 'add_item',
  productId: product.id,
  quantity,
  ...(variantId && { variantId }),
});
const pending = (candidates: Product[], quantity = 1) => {
  const c = fresh();
  c.pendingItemChoice = {
    candidateProductIds: candidates.map((p) => p.id),
    quantity,
    requestedOptionNames: [],
    notes: '',
    originalText: 'karahi',
  };
  return c;
};
const quantities = (c: Conversation) =>
  Object.fromEntries(c.cart.items.map((item) => [item.productId, item.quantity]));
const counts = (catalog: Product[], text: string) =>
  Object.fromEntries(
    parseActions(company, catalog, fresh(), text).flatMap((action) =>
      action.type === 'add_item' ? [[action.productId, action.quantity]] : [],
    ),
  );

describe('fx-6: one number is never two dishes’ count', () => {
  it.each([
    ['karahi half 4 naan', { [karahi.id]: 4, [naan.id]: 1 }],
    ['karahi 4 naan 2 lassi', { [karahi.id]: 4, [naan.id]: 2, [lassi.id]: 1 }],
    ['2 karahi 4 naan 2 lassi', { [karahi.id]: 2, [naan.id]: 4, [lassi.id]: 2 }],
    ['karahi 4 naan', { [karahi.id]: 4, [naan.id]: 1 }],
    // The earlier readings stay.
    ['3 naan 2 chicken biryani', { [naan.id]: 3, [biryani.id]: 2 }],
    ['naan 3 chicken biryani 2', { [naan.id]: 3, [biryani.id]: 2 }],
    ['karahi, 4 naan', { [karahi.id]: 1, [naan.id]: 4 }],
    ['karahi aur 4 naan', { [karahi.id]: 1, [naan.id]: 4 }],
  ] as const)('“%s”', (text, expected) => {
    expect(counts(products, text)).toEqual(expected);
  });

  it('gives a count only to the dish it can only belong to', () => {
    expect(clearQuantityNear(karahi, 'chicken wali 4 naan', products)).toBeUndefined();
    expect(clearQuantityNear(karahi, 'chicken wali half 4 naan', products)).toBeUndefined();
    expect(clearQuantityNear(biryani, 'chicken wali 3', products)).toBe(3);
    expect(clearQuantityNear(biryani, 'chicken biryani 2 de do', products)).toBe(2);
    expect(clearQuantityNear(biryani, 'chicken biryani 3 plate', products)).toBe(3);
    expect(clearQuantityNear(biryani, '2 chicken biryani', products)).toBe(2);
    expect(clearQuantityNear(biryani, 'naan 3 chicken biryani 2', products)).toBe(2);
    expect(clearQuantityNear(biryani, 'chicken biryani, make it 3', products)).toBe(3);
  });

  it('refuses a four-digit count instead of adding 1', () => {
    expect(quantityOfMention(naan, 'naan', '1000 naan', products)).toBe(1000);
    const result = turn(products, fresh(), '1000 naan');
    expect(result.conversation.cart.items).toEqual([]);
    expect(result.reply).toBe('Choose a quantity between 1 and 50.');
  });
});

describe('fx-6: answering “which one?” with a count before another dish', () => {
  it.each([
    ['chicken wali 4 naan', [add(karahi, 1, half.id), add(naan, 4)], 4],
    ['chicken wali half 4 naan', [add(karahi, 1, half.id), add(naan, 4)], 4],
    ['chicken karahi 4 naan', [add(karahi, 1, half.id), add(naan, 4)], 4],
    ['chicken wali full 6 naan', [add(karahi, 1), add(naan, 6)], 6],
  ] as const)('“%s” keeps the AI’s 1 karahi', (text, actions, naans) => {
    const result = turn(karahis, pending([karahi, mutton]), text, [...actions]);
    expect(quantities(result.conversation)).toEqual({ [karahi.id]: 1, [naan.id]: naans });
    expect(result.traces).toContain('item_choice_resolved');
    expect(result.reply).toContain('Added 1 × Chicken Karahi');
  });

  it.each([
    ['chicken wali 3 naan', [add(biryani, 1), add(naan, 3)], { [biryani.id]: 1, [naan.id]: 3 }],
    ['chicken wali 3 naan bhi', [add(biryani, 1), add(naan, 3)], { [biryani.id]: 1, [naan.id]: 3 }],
    ['chicken wali 2 tikka', [add(biryani, 1), add(tikka, 2)], { [biryani.id]: 1, [tikka.id]: 2 }],
    // The customer's own count for the dish still counts.
    ['chicken wali 3', [add(biryani, 3)], { [biryani.id]: 3 }],
    [
      'naan 3 chicken biryani 2',
      [add(biryani, 2), add(naan, 3)],
      { [biryani.id]: 2, [naan.id]: 3 },
    ],
    ['chicken wali, 4 naan', [add(biryani, 1), add(naan, 4)], { [biryani.id]: 1, [naan.id]: 4 }],
    ['chicken wali aur 4 naan', [add(biryani, 1), add(naan, 4)], { [biryani.id]: 1, [naan.id]: 4 }],
  ] as const)('“%s” (pending biryani) gives each dish its count', (text, actions, expected) => {
    const result = turn(biryanis, pending([biryani, beef]), text, [...actions]);
    expect(quantities(result.conversation)).toEqual(expected);
  });

  it('keeps the pending count with only the local rules', () => {
    expect(
      parseActions(company, karahis, pending([karahi, mutton]), 'chicken wali 4 naan')[0],
    ).toMatchObject({ type: 'add_item', productId: karahi.id, quantity: 1 });
    expect(
      parseActions(company, karahis, pending([karahi, mutton], 2), 'chicken wali 4 naan')[0],
    ).toMatchObject({ quantity: 2 });
    expect(
      parseActions(company, biryanis, pending([biryani, beef]), 'naan 3 chicken biryani 2')[0],
    ).toMatchObject({ productId: biryani.id, quantity: 2 });
  });
});

describe('fx-6: “karahi 4 naan” on a menu with two karahis', () => {
  it.each([
    [
      'the AI asks which one',
      [
        {
          type: 'clarify_item',
          candidateProductIds: [karahi.id, mutton.id],
          quantity: 1,
        } as BotAction,
        add(naan, 4),
      ],
    ],
    ['the AI picks one', [add(karahi, 1), add(naan, 4)]],
  ])('keeps the AI’s 4 naan and asks about 1 karahi when %s', (_, actions) => {
    const asked = turn(karahis, fresh(), 'karahi 4 naan', actions, {
      text: 'Which karahi?',
      askFor: 'none',
    });
    expect(asked.traces).toContain('ambiguous_addition_prevented');
    expect(quantities(asked.conversation)).toEqual({ [naan.id]: 4 });
    expect(asked.conversation.pendingItemChoice).toMatchObject({
      candidateProductIds: [karahi.id, mutton.id],
      quantity: 1,
    });
    expect(asked.reply).toContain('Added 4 × Butter Naan');
    expect(asked.reply).toContain('Which one would you like?');
    const picked = turn(karahis, asked.conversation, 'chicken half', [add(karahi, 1, half.id)]);
    expect(quantities(picked.conversation)).toEqual({ [naan.id]: 4, [karahi.id]: 1 });
  });

  it('still asks with the count written next to the karahi', () => {
    const asked = turn(karahis, fresh(), '2 karahi aur 4 naan', [add(karahi, 2), add(naan, 4)]);
    expect(asked.conversation.pendingItemChoice?.quantity).toBe(2);
  });
});
