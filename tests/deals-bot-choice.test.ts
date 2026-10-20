import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { sellableCatalog } from '../src/shared/deals';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Deal, DealChoiceGroup, ModelResponse, Product } from '../src/shared/types';

// The bot asking for a deal's choices ("Choose Drink for Deal 1"), and the answers. Bun & Co.
// is open all day; Tuesday 20 October 2026 at 13:00 in Karachi.
const company = seedCompanies[1]!;
const now = '2026-10-20T08:00:00.000Z';
const seed = seedProducts.filter((p) => p.companyId === company.id);
const smash = seed.find((p) => p.name === 'Classic Smash')!;
const crispy = seed.find((p) => p.name === 'Crispy Chicken')!;
const fries = seed.find((p) => p.name === 'Loaded Fries')!;
const drinkProduct = (id: string, name: string): Product => ({
  id,
  companyId: company.id,
  name,
  description: '',
  category: 'Drinks',
  price: 15000,
  available: true,
  emoji: '🥤',
  aliases: ['sprite'],
  variants: [],
  modifiers: [],
});
const sprite345 = drinkProduct('sprite-345', 'Sprite 345ml');
const sprite15 = drinkProduct('sprite-15', 'Sprite 1.5L');
const drink: DealChoiceGroup = {
  id: 'g-drink',
  name: 'Drink',
  options: [
    { id: 'o-coke', name: 'Coke', price: 0 },
    { id: 'o-sprite', name: 'Sprite', price: 0 },
    { id: 'o-fanta', name: 'Fanta', price: 5000 },
  ],
};
const side: DealChoiceGroup = {
  id: 'g-side',
  name: 'Side',
  options: [
    { id: 'o-fries', name: 'Fries', price: 0 },
    { id: 'o-wings', name: 'Wings', price: 10000 },
  ],
};
const deal = (id: string, name: string, choices: DealChoiceGroup[], position: number): Deal => ({
  id,
  companyId: company.id,
  name,
  description: '',
  emoji: '🎁',
  aliases: [],
  price: 79900,
  items: [{ name: 'Zinger burger', quantity: 1 }],
  choices,
  available: true,
  position,
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const products = sellableCatalog(
  company,
  [...seed, sprite345, sprite15],
  [deal('deal-1', 'Deal 1', [drink], 1), deal('deal-3', 'Deal 3', [drink, side], 3)],
  now,
  { all: true },
);
const ASK_DRINK = 'Choose Drink for Deal 1:\n1. Coke\n2. Sprite\n3. Fanta (+Rs. 50)';
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
    send(text: string, actions?: BotAction[], response?: ModelResponse) {
      const result = processTurn(
        company,
        products,
        conversation,
        { messageId: `m${++n}`, text, now },
        actions,
        response,
      );
      conversation = result.conversation;
      return result;
    },
  };
}

describe('asking for a deal’s choice', () => {
  it('asks the open choice, by its name, and adds the deal once it is answered by number', () => {
    const c = chat();
    const asked = c.send('deal 1');
    expect(asked.reply).toBe(ASK_DRINK);
    expect(asked.traces).toEqual(['add_item', 'deal_choice_asked']);
    expect(c.conversation.pendingDealChoice).toEqual({
      productId: 'deal-1',
      quantity: 1,
      picked: [],
      notes: '',
    });
    expect(c.items).toEqual([]);
    const answered = c.send('2');
    expect(answered.reply).toBe(
      'Added 1 × Deal 1 (Drink: Sprite). Add anything else, or send “review”.',
    );
    expect(answered.traces).toEqual(['add_item', 'deal_choice_answered']);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    expect(c.items).toEqual(['deal-1 ×1 [o-sprite]']);
  });

  it('takes an option’s name as the answer, never the drinks of that name', () => {
    const c = chat();
    c.send('deal 1');
    expect(parseActions(company, products, c.conversation, 'sprite')).toEqual([
      { type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-sprite'], notes: '' },
    ]);
    const result = c.send('sprite');
    expect(result.reply).not.toContain('Which one would you like?');
    expect(c.items).toEqual(['deal-1 ×1 [o-sprite]']);
    // "option 3", "3rd" and Urdu digits count as numbers.
    for (const answer of ['option 3', '3rd', '۳']) {
      const other = chat();
      other.send('deal 1');
      other.send(answer);
      expect(other.items).toEqual(['deal-1 ×1 [o-fanta]']);
    }
  });

  it('asks each choice in turn, keeps earlier picks, and fills several from one answer', () => {
    const c = chat();
    expect(c.send('deal 3').reply).toBe(ASK_DRINK.replace('Deal 1', 'Deal 3'));
    const next = c.send('coke');
    expect(next.reply).toBe('Choose Side for Deal 3:\n1. Fries\n2. Wings (+Rs. 100)');
    expect(c.conversation.pendingDealChoice?.picked).toEqual(['o-coke']);
    c.send('wings');
    expect(c.items).toEqual(['deal-3 ×1 [o-coke, o-wings]']);
    const both = chat();
    both.send('deal 3');
    both.send('coke aur fries');
    expect(both.items).toEqual(['deal-3 ×1 [o-coke, o-fries]']);
  });

  it('keeps the question open when the answer is not one option of it', () => {
    const c = chat();
    c.send('deal 1');
    for (const unclear of ['coke ya fanta?', '7', 'fries wali']) {
      expect(parseActions(company, products, c.conversation, unclear)[0]).not.toMatchObject({
        type: 'add_item',
        productId: 'deal-1',
      });
      c.send(unclear, [{ type: 'answer', text: '' }], {
        text: 'Please pick one drink.',
        askFor: 'none',
      });
      expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
      expect(c.items).toEqual([]);
    }
    c.send('1');
    expect(c.items).toEqual(['deal-1 ×1 [o-coke]']);
  });

  it('keeps the question through the menu, a question and the cart, and drops it on a new order or cancel', () => {
    const c = chat();
    c.send('deal 1');
    c.send('menu');
    c.send('what time do you close?', [{ type: 'answer', text: '' }], {
      text: 'We are open all day.',
      askFor: 'none',
      groundingIds: ['business:hours'],
    });
    c.send('show my order');
    expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    c.send('1');
    expect(c.items).toEqual(['deal-1 ×1 [o-coke]']);
    const restart = chat();
    restart.send('deal 1');
    restart.send('new order');
    expect(restart.conversation.pendingDealChoice).toBeUndefined();
    const cancelled = chat();
    cancelled.send('deal 1');
    cancelled.send('cancel');
    expect(cancelled.conversation.pendingDealChoice).toBeUndefined();
  });

  it('asks last in a turn that also adds, and drops an earlier question once something else is added', () => {
    const c = chat();
    const both = c.send('deal 1 aur 1 loaded fries');
    expect(both.reply).toBe(
      `Added 1 × Loaded Fries. Add anything else, or send “review”.\n\n${ASK_DRINK}`,
    );
    expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    // The customer moves on: the deal asked earlier is set aside.
    c.send('1 chicken burger');
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    expect(c.items).toEqual([`${fries.id} ×1`, `${crispy.id} ×1`]);
  });

  it('asks one deal at a time: a second deal waiting for choices is not added', () => {
    const c = chat();
    const result = c.send('deal 1 aur deal 3');
    expect(result.reply).toBe(`${ASK_DRINK}\n\nThen tell me the next deal.`);
    expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    expect(c.items).toEqual([]);
  });

  it('applies one pick to every unit asked for, unless a new count is written', () => {
    const c = chat();
    expect(c.send('2 deal 1').reply).toBe(ASK_DRINK.replace('for Deal 1', 'for 2 × Deal 1'));
    c.send('1');
    expect(c.items).toEqual(['deal-1 ×2 [o-coke]']);
    // The AI forgetting the count keeps it; a count the customer writes changes it.
    const ai = chat();
    ai.send('2 deal 1');
    ai.send(
      'coke',
      [{ type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-coke'] }],
      { text: 'Anything else?', askFor: 'anything_else' },
    );
    expect(ai.items).toEqual(['deal-1 ×2 [o-coke]']);
    const three = chat();
    three.send('2 deal 1');
    three.send(
      'coke, make it 3',
      [{ type: 'add_item', productId: 'deal-1', quantity: 3, modifierIds: ['o-coke'] }],
      { text: 'Anything else?', askFor: 'anything_else' },
    );
    expect(three.items).toEqual(['deal-1 ×3 [o-coke]']);
  });

  it('keeps a pick named with two deals of one word, for the one chosen', () => {
    const lunch = sellableCatalog(
      company,
      seed,
      [
        deal('zinger-lunch', 'Zinger Lunch Deal', [drink], 1),
        deal('biryani-lunch', 'Biryani Lunch Deal', [drink], 2),
      ],
      now,
      { all: true },
    );
    let conversation = createConversation(company.id, '923001234567', 'whatsapp', now);
    const turn = (text: string, messageId: string) => {
      const result = processTurn(company, lunch, conversation, { messageId, text, now });
      conversation = result.conversation;
      return result;
    };
    expect(turn('2 lunch deal with sprite', 'a').reply).toBe(
      'Which one would you like?\n1. Zinger Lunch Deal — Rs. 799\n2. Biryani Lunch Deal — Rs. 799',
    );
    expect(conversation.pendingItemChoice).toMatchObject({
      quantity: 2,
      requestedOptionNames: ['Sprite'],
    });
    // Another word of its name is enough to tell them apart.
    turn('zinger wali', 'b');
    expect(conversation.cart.items).toEqual([
      { productId: 'zinger-lunch', quantity: 2, modifierIds: ['o-sprite'], notes: '' },
    ]);
  });

  it('asks in Urdu and Roman Urdu with the owner’s choice and option names', () => {
    const urdu = chat().send('مجھے ڈیل 1 چاہیے', [
      { type: 'add_item', productId: 'deal-1', quantity: 1 },
    ]);
    expect(urdu.reply).toBe(
      'Deal 1 کے لیے Drink منتخب کریں:\n1. Coke\n2. Sprite\n3. Fanta (+Rs. 50)',
    );
    const roman = chat();
    expect(roman.send('mujhe deal 3 chahiye').reply).toBe(
      'Deal 3 ke liye Drink chunein:\n1. Coke\n2. Sprite\n3. Fanta (+Rs. 50)',
    );
    expect(roman.send('deal 1 aur deal 3 chahiye').reply).toContain('Phir agli deal batayein.');
  });
});

describe('the AI and the deal’s choice', () => {
  it('puts the AI’s lead-in before the choice list', () => {
    const c = chat();
    const result = c.send('deal 1', [{ type: 'add_item', productId: 'deal-1', quantity: 1 }], {
      text: 'Great pick!',
      askFor: 'none',
    });
    expect(result.reply).toBe(`Great pick!\n\n${ASK_DRINK}`);
  });

  it('reads the answer itself in place of the AI’s Sprite drink, "which Sprite?" or bare answer', () => {
    for (const proposal of [
      [{ type: 'add_item', productId: 'sprite-345', quantity: 1, modifierIds: [] }],
      [{ type: 'clarify_item', candidateProductIds: ['sprite-345', 'sprite-15'], quantity: 1 }],
      [{ type: 'answer', text: '' }],
    ] as BotAction[][]) {
      const c = chat();
      c.send('deal 1');
      const result = c.send('sprite', proposal, { text: 'Lovely!', askFor: 'none' });
      expect(result.traces).toContain('deal_choice_resolved');
      expect(result.traces).toContain('deal_choice_answered');
      expect(result.decision?.corrections).toContain('deal_choice_resolved');
      expect(c.items).toEqual(['deal-1 ×1 [o-sprite]']);
      expect(result.reply).toContain('Added 1 × Deal 1 (Drink: Sprite) — Rs. 799 each.');
    }
  });

  it('agrees with an AI that answered the choice, and keeps its picks for the next choices', () => {
    const c = chat();
    c.send('deal 3');
    const same = c.send(
      'sprite',
      [{ type: 'add_item', productId: 'deal-3', quantity: 1, modifierIds: ['o-sprite'] }],
      { text: 'And the side?', askFor: 'none' },
    );
    expect(same.traces).not.toContain('deal_choice_resolved');
    expect(same.reply).toBe(
      'And the side?\n\nChoose Side for Deal 3:\n1. Fries\n2. Wings (+Rs. 100)',
    );
    // The AI answering only the second choice keeps the first pick.
    const wings = c.send(
      'the second one',
      [{ type: 'add_item', productId: 'deal-3', quantity: 1, modifierIds: ['o-wings'] }],
      { text: 'Anything else?', askFor: 'anything_else' },
    );
    expect(wings.traces).toContain('deal_choice_answered');
    expect(c.items).toEqual(['deal-3 ×1 [o-sprite, o-wings]']);
    // An answer the engine can't read but the AI can: no "which Sprite?" beside it.
    const loose = chat();
    loose.send('deal 1');
    const result = loose.send(
      'sprite ya coke, sprite theek hai',
      [{ type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-sprite'] }],
      { text: 'Done.', askFor: 'none' },
    );
    expect(result.reply).not.toContain('Which one would you like?');
    expect(loose.items).toEqual(['deal-1 ×1 [o-sprite]']);
  });

  it('asks a dish choice first and the deal’s choice once that is answered', () => {
    const c = chat();
    const first = c.send(
      'deal 1 aur burger',
      [
        { type: 'add_item', productId: 'deal-1', quantity: 1 },
        { type: 'clarify_item', candidateProductIds: [smash.id, crispy.id], quantity: 1 },
      ],
      { text: '', askFor: 'none' },
    );
    expect(first.reply).toBe('Which one would you like?\n1. Classic Smash\n2. Crispy Chicken');
    expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    const second = c.send('2');
    expect(second.reply).toBe(
      `Added 1 × Crispy Chicken. Add anything else, or send “review”.\n\n${ASK_DRINK}`,
    );
    c.send('3');
    expect(c.items).toEqual([`${crispy.id} ×1`, 'deal-1 ×1 [o-fanta]']);
  });
});
