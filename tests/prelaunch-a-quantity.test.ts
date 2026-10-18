import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { mentionsQuantity, quantityBefore, quantityFromText } from '../src/domain/menu-resolver';
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
const fresh = () => createConversation(company.id, '923000000077', 'demo', now);
let message = 0;
function turn(
  c: Conversation,
  text: string,
  options: { actions?: BotAction[]; response?: ModelResponse; catalog?: Product[] } = {},
) {
  return processTurn(
    company,
    options.catalog ?? products,
    c,
    { messageId: `quantity-${++message}`, text, now },
    options.actions,
    options.response,
  );
}
const model = (text = '', askFor: ModelResponse['askFor'] = 'none'): ModelResponse => ({
  text,
  askFor,
});
const pendingFor = (candidates: Product[], quantity: number) => {
  const c = fresh();
  c.pendingItemChoice = {
    candidateProductIds: candidates.map((p) => p.id),
    quantity,
    requestedOptionNames: [],
    notes: '',
    originalText: `${quantity} chicken`,
  };
  return c;
};
const quantities = (c: Conversation) =>
  Object.fromEntries(c.cart.items.map((item) => [item.productId, item.quantity]));

describe('F08: a pending item choice keeps the right count', () => {
  it('uses the AI’s count when the customer wrote it after the dish', () => {
    const asked = turn(fresh(), '2 biryani', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
      response: model(),
      catalog: biryanis,
    });
    expect(asked.traces).toContain('ambiguous_addition_prevented');
    expect(asked.conversation.pendingItemChoice?.quantity).toBe(2);
    const picked = turn(asked.conversation, 'chicken biryani, make it 3', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 3 }],
      response: model('Anything else?', 'anything_else'),
      catalog: biryanis,
    });
    expect(quantities(picked.conversation)).toEqual({ [biryani.id]: 3 });
    expect(picked.reply).toContain('Added 3 × Chicken Biryani');
  });

  it('does not give the chosen dish another item’s count', () => {
    const asked = turn(fresh(), 'biryani', {
      actions: [
        {
          type: 'clarify_item',
          candidateProductIds: [biryani.id, beef.id],
          quantity: 1,
        },
      ],
      response: model(),
      catalog: biryanis,
    });
    expect(asked.conversation.pendingItemChoice?.quantity).toBe(1);
    const picked = turn(asked.conversation, 'chicken wali, aur 3 naan', {
      actions: [
        { type: 'add_item', productId: biryani.id, quantity: 1 },
        { type: 'add_item', productId: naan.id, quantity: 3 },
      ],
      response: model('Anything else?', 'anything_else'),
      catalog: biryanis,
    });
    expect(quantities(picked.conversation)).toEqual({ [biryani.id]: 1, [naan.id]: 3 });
    expect(picked.reply).toContain('Items subtotal: Rs. 750');
  });

  it('reads Roman Urdu “do” as two only right before the dish', () => {
    expect(parseActions(company, biryanis, fresh(), 'biryani de do')[0]).toMatchObject({
      type: 'clarify_item',
      quantity: 1,
    });
    expect(parseActions(company, biryanis, fresh(), 'biryani do na')[0]).toMatchObject({
      type: 'clarify_item',
      quantity: 1,
    });
    expect(parseActions(company, biryanis, fresh(), 'mujhe do biryani chahiye')[0]).toMatchObject({
      type: 'clarify_item',
      quantity: 2,
    });
    expect(
      parseActions(company, biryanis, pendingFor([biryani, beef], 1), 'do chicken wali')[0],
    ).toMatchObject({ type: 'add_item', productId: biryani.id, quantity: 2 });
    // The earlier choice of 1 is kept for "give me the chicken one".
    const answered = turn(pendingFor([biryani, beef], 1), 'chicken wali de do bhai', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      response: model(),
      catalog: biryanis,
    });
    expect(quantities(answered.conversation)).toEqual({ [biryani.id]: 1 });
  });

  it('keeps 1 for “tikka wala de do please” and takes a count after the dish', () => {
    const tikkaPick = turn(pendingFor([biryani, tikka], 1), 'tikka wala de do please', {
      actions: [{ type: 'add_item', productId: tikka.id, quantity: 1 }],
      response: model(),
    });
    expect(quantities(tikkaPick.conversation)).toEqual({ [tikka.id]: 1 });
    const three = turn(pendingFor([biryani, beef], 1), 'chicken wali 3', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 3 }],
      response: model(),
      catalog: biryanis,
    });
    expect(quantities(three.conversation)).toEqual({ [biryani.id]: 3 });
  });

  it('never reads a house number as the dish’s count', () => {
    const result = turn(
      pendingFor([biryani, beef], 1),
      'chicken wali, delivery, address: house 12 street 4 DHA',
      {
        actions: [
          { type: 'add_item', productId: biryani.id, quantity: 1 },
          {
            type: 'set_details',
            fulfillment: 'delivery',
            address: 'house 12 street 4',
            zone: 'DHA',
          },
        ],
        response: model(),
        catalog: biryanis,
      },
    );
    expect(quantities(result.conversation)).toEqual({ [biryani.id]: 1 });
  });

  it('still restores the pending count when the AI forgets it', () => {
    const result = turn(pendingFor([biryani, beef], 2), 'chicken', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      response: model(),
      catalog: biryanis,
    });
    expect(quantities(result.conversation)).toEqual({ [biryani.id]: 2 });
    // A count right before the dish replaces it.
    const revised = turn(pendingFor([biryani, beef], 2), '3 chicken biryani', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
      response: model(),
      catalog: biryanis,
    });
    expect(quantities(revised.conversation)).toEqual({ [biryani.id]: 3 });
  });

  it('exposes the count helpers it relies on', () => {
    expect(quantityBefore(biryani, 'actually 3 chicken biryyani')).toBe(3);
    expect(quantityBefore(biryani, '2x chicken biryani')).toBe(2);
    expect(quantityBefore(biryani, 'a chicken biryani')).toBeUndefined();
    expect(quantityBefore(biryani, 'chicken biryani 3')).toBeUndefined();
    expect(quantityBefore(products[1]!, '2 full chicken karahi')).toBe(2);
    expect(mentionsQuantity('make it 3', 3)).toBe(true);
    expect(mentionsQuantity('make it three', 3)).toBe(true);
    expect(mentionsQuantity('de do', 2)).toBe(false);
    expect(quantityFromText('biryani de do')).toBe(1);
    expect(quantityFromText('do chicken biryani')).toBe(2);
    expect(quantityFromText('دو بریانی')).toBe(2);
    expect(quantityFromText('بریانی دے دو')).toBe(1);
  });
});
