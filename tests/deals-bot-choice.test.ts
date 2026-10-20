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
    // `menu`: the menu as it is at this message (the owner may edit a deal in between).
    send(text: string, actions?: BotAction[], response?: ModelResponse, menu = products) {
      const result = processTurn(
        company,
        menu,
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
    // The list as shown is kept, so a number answers what the customer saw.
    expect(c.conversation.pendingDealChoice).toEqual({
      productId: 'deal-1',
      quantity: 1,
      picked: [],
      notes: '',
      groupId: 'g-drink',
      optionIds: ['o-coke', 'o-sprite', 'o-fanta'],
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

  it('applies one pick to every unit asked for, and adds the AI’s count as it is', () => {
    const c = chat();
    expect(c.send('2 deal 1').reply).toBe(ASK_DRINK.replace('for Deal 1', 'for 2 × Deal 1'));
    c.send('1');
    expect(c.items).toEqual(['deal-1 ×2 [o-coke]']);
    // The AI's count is never read again from the text (its prompt carries the count asked
    // about): 2 is 2, and an AI that forgot the count adds 1.
    for (const quantity of [2, 1]) {
      const ai = chat();
      ai.send('2 deal 1');
      ai.send(
        'coke',
        [{ type: 'add_item', productId: 'deal-1', quantity, modifierIds: ['o-coke'] }],
        { text: 'Anything else?', askFor: 'anything_else' },
      );
      expect(ai.items).toEqual([`deal-1 ×${quantity} [o-coke]`]);
    }
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
      // The AI's own answer stands; its Sprite drink beside it is that answer read twice.
      [
        { type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-sprite'] },
        { type: 'add_item', productId: 'sprite-345', quantity: 1, modifierIds: [] },
      ],
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

describe('a message that only mentions an option while the deal’s choice is open', () => {
  const ok: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' };
  const add = (productId: string, quantity = 1, modifierIds: string[] = []): BotAction => ({
    type: 'add_item',
    productId,
    quantity,
    modifierIds,
  });

  it.each([
    'no sprite',
    'not sprite please',
    'without sprite',
    'sprite mat dena',
    'sprite nahi',
    'remove sprite',
    'remove sprite 345ml',
    'also add a sprite 1.5L',
    '1 sprite',
    'do sprite',
  ])('never reads “%s” as the deal’s Sprite', (text) => {
    const c = chat();
    c.send('deal 1');
    expect(parseActions(company, products, c.conversation, text)).not.toContainEqual(
      expect.objectContaining({ productId: 'deal-1' }),
    );
  });

  it('still reads the answer beside an option turned down, or a deal’s own number', () => {
    const c = chat();
    c.send('deal 1');
    expect(parseActions(company, products, c.conversation, 'no sprite, coke please')).toEqual([
      { type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-coke'], notes: '' },
    ]);
    // "no diet coke" turns down the longer name, never leaving its "coke" as the answer.
    const diet = sellableCatalog(
      company,
      [...seed, sprite345, sprite15],
      [
        deal(
          'deal-1',
          'Deal 1',
          [
            {
              ...drink,
              options: [...drink.options, { id: 'o-diet', name: 'Diet Coke', price: 0 }],
            },
          ],
          1,
        ),
      ],
      now,
      { all: true },
    );
    const d = chat();
    d.send('deal 1', undefined, undefined, diet);
    expect(parseActions(company, diet, d.conversation, 'no diet coke')[0]).not.toMatchObject({
      productId: 'deal-1',
    });
    // The 1 of "deal 1" counts no Coke.
    expect(parseActions(company, products, c.conversation, 'deal 1 coke')).toEqual([
      { type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-coke'], notes: '' },
    ]);
  });

  it('leaves the question open when the AI reads a refusal, a removal or a question', () => {
    const c = chat();
    c.send('deal 1');
    const refused = c.send('no sprite', [{ type: 'answer', text: '' }], {
      text: 'Which drink would you like instead?',
      askFor: 'none',
    });
    expect(refused.reply).toBe('Which drink would you like instead?');
    expect(refused.traces).not.toContain('deal_choice_resolved');
    const asked = c.send('sprite kitne ki hai', [{ type: 'answer', text: '' }], {
      text: 'It comes with the deal.',
      askFor: 'none',
    });
    expect(asked.reply).toBe('It comes with the deal.');
    expect(c.items).toEqual([]);
    expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    const removal = chat();
    // As main reads it, "1 sprite 345ml" alone would also add the Sprite 1.5L ("sprite").
    removal.send('1 sprite 345ml', [add('sprite-345')], ok);
    removal.send('deal 1');
    const removed = removal.send(
      'remove sprite 345ml',
      [{ type: 'remove_item', productId: 'sprite-345' }],
      ok,
    );
    expect(removed.traces).not.toContain('deal_choice_resolved');
    expect(removal.items).toEqual([]);
    expect(removal.conversation.pendingDealChoice?.productId).toBe('deal-1');
  });

  it('keeps a dish ordered by its longer name or with its own count beside the answer', () => {
    // Side open: "fries" answers it, and the Loaded Fries ordered beside it stay.
    const both = chat();
    both.send('deal 3 with sprite');
    both.send(
      'fries, aur 1 loaded fries bhi',
      [add('deal-3', 1, ['o-sprite', 'o-fries']), add(fries.id)],
      ok,
    );
    expect(both.items).toEqual(['deal-3 ×1 [o-fries, o-sprite]', `${fries.id} ×1`]);
    // Only the Loaded Fries: the AI's and the engine's reading add them, never the deal.
    for (const actions of [[add(fries.id, 2)], undefined]) {
      const c = chat();
      c.send('deal 3 with sprite');
      c.send('aur 2 loaded fries bhi', actions, actions && ok);
      expect(c.items).toEqual([`${fries.id} ×2`]);
    }
    const bottle = chat();
    bottle.send('deal 1');
    bottle.send('also add a sprite 1.5L', [add('sprite-15')], ok);
    expect(bottle.items).toEqual(['sprite-15 ×1']);
    // "coke" answers; the two Sprites with their own count are the AI's to add.
    const counted = chat();
    counted.send('deal 1');
    counted.send('coke, aur 2 sprite', [add('deal-1', 1, ['o-coke']), add('sprite-345', 2)], ok);
    expect(counted.items).toEqual(['deal-1 ×1 [o-coke]', 'sprite-345 ×2']);
  });
});

describe('a deal’s choice answered by number after the owner changed it', () => {
  const menu = (deals: Deal[]) =>
    sellableCatalog(company, [...seed, sprite345, sprite15], deals, now, { all: true });
  const noCoke = menu([
    deal('deal-1', 'Deal 1', [{ ...drink, options: drink.options.slice(1) }], 1),
    deal('deal-3', 'Deal 3', [side], 3),
  ]);

  it('reads the number against the list the customer saw', () => {
    for (const [answer, pick] of [
      ['2', 'o-sprite'],
      ['3', 'o-fanta'],
    ]) {
      const c = chat();
      c.send('deal 1');
      c.send(answer!, undefined, undefined, noCoke);
      expect(c.items).toEqual([`deal-1 ×1 [${pick}]`]);
    }
    // The AI's add of the deal is its own reading, even of "2" against the list as it is now
    // (Fanta): the engine does not pick again for it.
    const ai = chat();
    ai.send('deal 1');
    const result = ai.send(
      '2',
      [{ type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-fanta'] }],
      { text: 'Done.', askFor: 'none' },
      noCoke,
    );
    expect(result.traces).not.toContain('deal_choice_resolved');
    expect(ai.items).toEqual(['deal-1 ×1 [o-fanta]']);
  });

  it('asks again, from the list as it is now, when the option or the choice asked is gone', () => {
    const c = chat();
    c.send('deal 3');
    const again = c.send('2', undefined, undefined, noCoke);
    expect(again.reply).toBe('Choose Side for Deal 3:\n1. Fries\n2. Wings (+Rs. 100)');
    expect(c.items).toEqual([]);
    expect(c.conversation.pendingDealChoice).toMatchObject({ groupId: 'g-side' });
    c.send('2', undefined, undefined, noCoke);
    expect(c.items).toEqual(['deal-3 ×1 [o-wings]']);
    const noSprite = menu([
      deal('deal-1', 'Deal 1', [{ ...drink, options: [drink.options[0]!, drink.options[2]!] }], 1),
    ]);
    const gone = chat();
    gone.send('deal 1');
    expect(gone.send('2', undefined, undefined, noSprite).reply).toBe(
      'Choose Drink for Deal 1:\n1. Coke\n2. Fanta (+Rs. 50)',
    );
    expect(gone.items).toEqual([]);
  });

  it('reads a number by the deal as it is for a choice asked before the list was kept', () => {
    const conversation = {
      ...createConversation(company.id, '923001234567', 'whatsapp', now),
      pendingDealChoice: { productId: 'deal-1', quantity: 1, picked: [], notes: '' },
    };
    const result = processTurn(company, products, conversation, {
      messageId: 'm1',
      text: '2',
      now,
    });
    expect(result.conversation.cart.items).toMatchObject([
      { productId: 'deal-1', modifierIds: ['o-sprite'] },
    ]);
  });
});

describe('a deal’s choice waiting behind a dish choice when the owner changes the deal', () => {
  const menu = (deal3: Deal) =>
    sellableCatalog(
      company,
      [...seed, sprite345, sprite15],
      [deal('deal-1', 'Deal 1', [drink], 1), deal3],
      now,
      { all: true },
    );

  it('drops it, with no error, when the choice it waited for is gone', () => {
    for (const choices of [[drink], []]) {
      const c = chat();
      expect(c.send('deal 3 with sprite aur burger').reply).toBe(
        'Which one would you like?\n1. Classic Smash\n2. Crispy Chicken',
      );
      const result = c.send('2', undefined, undefined, menu(deal('deal-3', 'Deal 3', choices, 3)));
      expect(result.reply).toBe('Added 1 × Crispy Chicken. Add anything else, or send “review”.');
      expect(result.traces).toEqual(['add_item']);
      expect(c.items).toEqual([`${crispy.id} ×1`]);
      expect(c.conversation.pendingItemChoice).toBeUndefined();
      expect(c.conversation.pendingDealChoice).toBeUndefined();
    }
  });

  it('says the deal is not on when it was paused meanwhile, instead of asking its choice', () => {
    const c = chat();
    c.send('deal 3 with sprite aur burger');
    const paused = menu({ ...deal('deal-3', 'Deal 3', [drink, side], 3), available: false });
    const result = c.send('2', undefined, undefined, paused);
    expect(result.reply).toBe(
      'Added 1 × Crispy Chicken. Add anything else, or send “review”.\n\nDeal 3 is not available right now.',
    );
    expect(c.conversation.pendingDealChoice).toBeUndefined();
  });
});

describe('a "which deal?" answered, then the deal’s own choice', () => {
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
  const which: BotAction = {
    type: 'clarify_item',
    candidateProductIds: ['zinger-lunch', 'biryani-lunch'],
    quantity: 1,
  };
  const quiet: ModelResponse = { text: 'Done.', askFor: 'none' };

  it('reads the next number as the drink, never as the other deal', () => {
    const c = chat();
    c.send('lunch deal', undefined, undefined, lunch);
    expect(c.send('1', undefined, undefined, lunch).reply).toBe(
      'Choose Drink for Zinger Lunch Deal:\n1. Coke\n2. Sprite\n3. Fanta (+Rs. 50)',
    );
    expect(c.conversation.pendingItemChoice).toBeUndefined();
    c.send('2', undefined, undefined, lunch);
    expect(c.items).toEqual(['zinger-lunch ×1 [o-sprite]']);
  });

  const asked = () => {
    const c = chat();
    c.send('lunch deal', [which], quiet, lunch);
    c.send('1', [{ type: 'add_item', productId: 'zinger-lunch', quantity: 1 }], quiet, lunch);
    return c;
  };

  it('reads the number as the drink when the AI changes nothing in the cart', () => {
    const c = asked();
    const result = c.send('2', [{ type: 'answer', text: '' }], quiet, lunch);
    expect(result.traces).toContain('deal_choice_resolved');
    expect(result.traces).not.toContain('item_choice_resolved');
    expect(result.reply).not.toContain('Which one would you like?');
    expect(c.items).toEqual(['zinger-lunch ×1 [o-sprite]']);
    expect(c.conversation.pendingItemChoice).toBeUndefined();
  });

  it('keeps the AI’s own "which deal?" or its add without the pick on that number', () => {
    const again = asked();
    expect(again.send('2', [which], quiet, lunch).reply).toContain(
      'Which one would you like?\n1. Zinger Lunch Deal — Rs. 799\n2. Biryani Lunch Deal — Rs. 799',
    );
    expect(again.conversation.pendingItemChoice?.candidateProductIds).toHaveLength(2);
    const unpicked = asked();
    const result = unpicked.send(
      '2',
      [{ type: 'add_item', productId: 'zinger-lunch', quantity: 1 }],
      quiet,
      lunch,
    );
    expect(result.traces).toEqual(['add_item', 'deal_choice_asked']);
    expect(result.reply).toContain('Choose Drink for Zinger Lunch Deal:');
    expect(unpicked.items).toEqual([]);
  });
});

describe('a deal’s choice left open when the deal goes off', () => {
  // Friday 23 October 2026: Lunch Deal runs Mon–Fri 12:00–15:00.
  const at = (local: string, date = '2026-10-23') =>
    new Date(`${date}T${local}:00+05:00`).toISOString();
  const lunch: Deal = {
    ...deal('lunch', 'Lunch Deal', [{ ...drink, options: drink.options.slice(0, 2) }], 1),
    schedule: { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' },
  };
  const menuAt = (when: string, deals: Deal[] = [lunch]) =>
    sellableCatalog(company, [...seed, sprite345], deals, when, { all: true });
  function timed() {
    let conversation = createConversation(company.id, '923001234567', 'whatsapp', at('14:00'));
    let n = 0;
    return {
      get conversation() {
        return conversation;
      },
      send(text: string, when: string, actions?: BotAction[], menu = menuAt(when)) {
        const result = processTurn(
          company,
          menu,
          conversation,
          { messageId: `t${++n}`, text, now: when },
          actions,
          actions && { text: 'Anything else?', askFor: 'anything_else' },
        );
        conversation = result.conversation;
        return result;
      },
    };
  }
  const refusal = 'Lunch Deal is only available Mon–Fri 12:00–15:00.';

  it('refuses it once, then a drink is that drink, also once the deal is back on', () => {
    const c = timed();
    c.send('lunch deal', at('14:59'));
    const late = c.send('sprite', at('15:05'));
    expect(late.reply).toBe(refusal);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    expect(c.send('sprite', at('15:06')).reply).toBe(
      'Added 1 × Sprite 345ml. Add anything else, or send “review”.',
    );
    const monday = timed();
    monday.send('lunch deal', at('14:59'));
    monday.send('2', at('15:05'));
    monday.send('sprite', at('13:00', '2026-10-26'));
    expect(monday.conversation.cart.items.map((item) => item.productId)).toEqual(['sprite-345']);
  });

  it('lets the drink be ordered by its own name straight away', () => {
    const c = timed();
    c.send('lunch deal', at('14:59'));
    expect(c.send('sprite 345ml', at('15:05')).reply).toBe(
      'Added 1 × Sprite 345ml. Add anything else, or send “review”.',
    );
    expect(c.conversation.pendingDealChoice).toBeUndefined();
  });

  it('refuses once on the AI path too, then keeps the AI’s drink', () => {
    const c = timed();
    c.send('lunch deal', at('14:59'));
    const sprite: BotAction[] = [{ type: 'add_item', productId: 'sprite-345', quantity: 1 }];
    // "sprite" alone answers the deal, which is no longer on.
    expect(c.send('sprite', at('15:05'), sprite).reply).toBe(refusal);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    c.send('sprite', at('15:06'), sprite);
    expect(c.conversation.cart.items.map((item) => item.productId)).toEqual(['sprite-345']);
    // A longer message is the AI's to read: its drink is added, and the question is over.
    const longer = timed();
    longer.send('lunch deal', at('14:59'));
    expect(longer.send('just a sprite then', at('15:05'), sprite).reply).toBe(
      'Added 1 × Sprite 345ml — Rs. 150 each.\nItems subtotal: Rs. 150.\n\nAnything else?',
    );
    expect(longer.conversation.pendingDealChoice).toBeUndefined();
  });

  it('is cleared with the refusal when the owner pauses the deal', () => {
    const c = timed();
    c.send('lunch deal', at('13:00'));
    const paused = menuAt(at('13:05'), [{ ...lunch, available: false }]);
    expect(c.send('2', at('13:05'), undefined, paused).reply).toBe(
      'Lunch Deal is not available right now.',
    );
    expect(c.conversation.pendingDealChoice).toBeUndefined();
  });
});

const askMore: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' };
const addOf = (productId: string, quantity = 1, modifierIds: string[] = []): BotAction => ({
  type: 'add_item',
  productId,
  quantity,
  modifierIds,
});

describe('a deal turned down while its choice is asked', () => {
  it.each([
    'deal 1 nahi chahiye',
    'nahi rehne do',
    'no thanks',
    'remove deal 1',
    'cancel deal 1',
    'ڈیل 1 نہیں چاہیے',
    'i don’t want the deal',
  ])('takes it off on “%s”, so a later drink is that drink', (text) => {
    // Without the AI: the refusal is said back, and nothing is added.
    const local = chat();
    local.send('deal 1');
    const refused = local.send(text);
    expect(refused.traces).toEqual(['remove_item']);
    expect(local.conversation.pendingDealChoice).toBeUndefined();
    expect(local.items).toEqual([]);
    // "sprite" now asks which Sprite drink, as on any menu, never the deal.
    expect(local.send('sprite').reply).toBe(
      'Which one would you like?\n1. Sprite 345ml\n2. Sprite 1.5L',
    );
    // The AI answering the refusal in words: the engine still takes the deal off, and the AI’s
    // Sprite drink next is a drink (which of the two Sprites), not the deal.
    const ai = chat();
    ai.send('deal 1');
    ai.send(text, [{ type: 'answer', text: '' }], { text: 'No problem.', askFor: 'none' });
    expect(ai.conversation.pendingDealChoice).toBeUndefined();
    const sprite = ai.send('sprite', [addOf('sprite-345')], askMore);
    expect(sprite.traces).not.toContain('deal_choice_answered');
    expect(ai.items).toEqual([]);
    expect(ai.conversation.pendingItemChoice?.candidateProductIds.sort()).toEqual([
      'sprite-15',
      'sprite-345',
    ]);
    ai.send('sprite 345ml', [addOf('sprite-345')], askMore);
    expect(ai.items).toEqual(['sprite-345 ×1']);
  });

  it('takes the AI’s removal of the deal asked as the deal turned down, and keeps its add of it', () => {
    const removed = chat();
    removed.send('deal 1');
    const result = removed.send(
      'nahi deal 1 rehne do, hata do',
      [{ type: 'remove_item', productId: 'deal-1' }],
      { text: 'Done.', askFor: 'none' },
    );
    expect(result.reply).toBe('Theek hai, Deal 1 add nahi kiya.\n\nDone.');
    expect(result.traces).not.toContain('validation_failed:remove_item');
    expect(removed.conversation.pendingDealChoice).toBeUndefined();
    removed.send('sprite', [addOf('sprite-345')], askMore);
    expect(removed.items).toEqual([]);
    expect(removed.conversation.pendingItemChoice?.candidateProductIds).toHaveLength(2);
    // An AI that adds the deal is not overruled by the engine's reading of a refusal: the deal
    // is added as the AI proposed, and its question is over.
    const added = chat();
    added.send('deal 1');
    const kept = added.send('deal 1 nahi chahiye', [addOf('deal-1', 1, ['o-coke'])], askMore);
    expect(kept.traces).toEqual(['add_item', 'deal_choice_answered']);
    expect(added.items).toEqual(['deal-1 ×1 [o-coke]']);
    expect(added.conversation.pendingDealChoice).toBeUndefined();
  });

  it('keeps one already in the cart, and says how to take it out', () => {
    const c = chat();
    c.send('deal 1 with coke');
    c.send('ek aur deal 1');
    expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    expect(c.send('remove deal 1').reply).toBe(
      'Okay, Deal 1 is not added. The Deal 1 already in your cart stays: send “remove Deal 1” to take it out.',
    );
    expect(c.items).toEqual(['deal-1 ×1 [o-coke]']);
    expect(c.conversation.pendingDealChoice).toBeUndefined();
    c.send('remove deal 1');
    expect(c.items).toEqual([]);
  });

  it('keeps the question for what does not turn the deal down', () => {
    for (const text of [
      'no sprite',
      'drink nahi chahiye',
      'nahi, deal 1 chahiye',
      'nahi 2',
      'nahi coke',
      'deal 1 nahi, deal 3',
      'no, make it 2',
    ]) {
      const c = chat();
      c.send('deal 1');
      expect(parseActions(company, products, c.conversation, text)).not.toContainEqual({
        type: 'remove_item',
        productId: 'deal-1',
      });
      c.send(text, [{ type: 'answer', text: '' }], { text: 'Which drink?', askFor: 'none' });
      expect(c.conversation.pendingDealChoice?.productId).toBe('deal-1');
    }
    // A deal waiting behind a dish's "which one?": a "nahi" answers the dish question.
    const waiting = chat();
    waiting.send(
      'deal 1 aur burger',
      [
        addOf('deal-1'),
        { type: 'clarify_item', candidateProductIds: [smash.id, crispy.id], quantity: 1 },
      ],
      { text: '', askFor: 'none' },
    );
    expect(parseActions(company, products, waiting.conversation, 'nahi')).not.toContainEqual({
      type: 'remove_item',
      productId: 'deal-1',
    });
  });
});

describe('the AI’s reading of the choice when the parser reads none', () => {
  it('takes the AI’s pick where the deal is named again with an answer only the AI reads', () => {
    for (const text of ['deal 1 with sprit', 'deal 1 option 2', 'ڈیل 1 کے لیے سپرائٹ']) {
      const c = chat();
      c.send('deal 1');
      const result = c.send(text, [addOf('deal-1', 1, ['o-sprite'])], askMore);
      expect(result.traces).not.toContain('deal_choice_asked');
      expect(c.items).toEqual(['deal-1 ×1 [o-sprite]']);
      expect(c.conversation.pendingDealChoice).toBeUndefined();
    }
  });

  it('keeps the AI’s pick beside an option turned down, or from a list changed since', () => {
    // The engine never re-reads the AI's pick: what it adds is what the AI proposed.
    const refused = chat();
    refused.send('deal 1');
    refused.send('deal 1, sprite nahi', [addOf('deal-1', 1, ['o-sprite'])], askMore);
    expect(refused.items).toEqual(['deal-1 ×1 [o-sprite]']);
    const noSprite = sellableCatalog(
      company,
      [...seed, sprite345, sprite15],
      [
        deal(
          'deal-1',
          'Deal 1',
          [{ ...drink, options: [drink.options[0]!, drink.options[2]!] }],
          1,
        ),
      ],
      now,
      { all: true },
    );
    const changed = chat();
    changed.send('deal 1');
    changed.send('deal 1 option 2', [addOf('deal-1', 1, ['o-fanta'])], askMore, noSprite);
    expect(changed.items).toEqual(['deal-1 ×1 [o-fanta]']);
    // A pick the deal no longer has is dropped and asked again.
    const gone = chat();
    gone.send('deal 1');
    expect(
      gone.send('deal 1 option 2', [addOf('deal-1', 1, ['o-sprite'])], askMore, noSprite).reply,
    ).toBe('Choose Drink for Deal 1:\n1. Coke\n2. Fanta (+Rs. 50)');
    expect(gone.items).toEqual([]);
  });
});

describe('a drink of the answer’s name ordered again on its own', () => {
  it.each([
    ['sprite, aur ek sprite alag se', 1],
    ['sprite, and one more sprite separately', 1],
    ['sprite aur ek extra sprite', 1],
    ['sprite, aur 2 sprite bhi', 2],
  ] as const)('keeps the AI’s drink beside the deal on “%s”', (text, count) => {
    const c = chat();
    c.send('deal 1');
    const result = c.send(
      text,
      [addOf('deal-1', 1, ['o-sprite']), addOf('sprite-345', count)],
      askMore,
    );
    expect(result.traces).not.toContain('deal_choice_resolved');
    expect(c.items).toEqual(['deal-1 ×1 [o-sprite]', `sprite-345 ×${count}`]);
  });

  it('keeps the AI’s drink also when the answer is said twice, and asks which drink without the AI', () => {
    // Only the AI reads whether a second "sprite" is a drink of its own.
    const twice = chat();
    twice.send('deal 1');
    twice.send(
      'sprite, haan sprite hi',
      [addOf('deal-1', 1, ['o-sprite']), addOf('sprite-345')],
      askMore,
    );
    expect(twice.items).toEqual(['deal-1 ×1 [o-sprite]', 'sprite-345 ×1']);
    // Two drinks are called Sprite here: the deal is added, then which one.
    const local = chat();
    local.send('deal 1');
    expect(local.send('sprite, aur ek sprite alag se').reply).toMatch(
      /^Which one would you like\?\n1\. Sprite (?:345ml|1\.5L)\n2\. Sprite (?:345ml|1\.5L)$/u,
    );
    expect(local.items).toEqual(['deal-1 ×1 [o-sprite]']);
    local.send('sprite 345ml');
    expect(local.items).toEqual(['deal-1 ×1 [o-sprite]', 'sprite-345 ×1']);
  });
});

describe('a pick made earlier, changed while the next choice is asked', () => {
  it('takes the AI’s change to an option the customer wrote, at its price', () => {
    const c = chat();
    c.send('deal 3');
    c.send('fanta');
    const result = c.send(
      'sorry, coke not fanta. and fries',
      [addOf('deal-3', 1, ['o-coke', 'o-fries'])],
      askMore,
    );
    expect(result.reply).toContain('Added 1 × Deal 3 (Drink: Coke, Side: Fries) — Rs. 799 each.');
    expect(result.traces).not.toContain('deal_choice_resolved');
    expect(c.items).toEqual(['deal-3 ×1 [o-coke, o-fries]']);
  });

  it('takes the Add dialog’s picks in Test your bot, with and without the AI', () => {
    const local = chat();
    local.send('deal 3');
    local.send('coke');
    local.send('Add 1 Deal 3 with Sprite / Wings');
    expect(local.items).toEqual(['deal-3 ×1 [o-sprite, o-wings]']);
    const ai = chat();
    ai.send('deal 3');
    ai.send('coke');
    const result = ai.send(
      'Add 1 Deal 3 with Sprite / Wings',
      [addOf('deal-3', 1, ['o-sprite', 'o-wings'])],
      askMore,
    );
    expect(result.reply).toContain('Rs. 899 each.');
    expect(ai.items).toEqual(['deal-3 ×1 [o-sprite, o-wings]']);
  });

  it('keeps the earlier pick when only the next choice is answered', () => {
    for (const proposal of [
      undefined,
      [addOf('deal-3', 1, ['o-fries'])],
      [addOf('deal-3', 1, ['o-fanta', 'o-fries'])],
    ]) {
      const c = chat();
      c.send('deal 3');
      c.send('fanta');
      c.send('fries', proposal, proposal && askMore);
      expect(c.items).toEqual(['deal-3 ×1 [o-fanta, o-fries]']);
    }
    // The AI's pick for a choice it names is its own, also one made before.
    const c = chat();
    c.send('deal 3');
    c.send('fanta');
    c.send('fries', [addOf('deal-3', 1, ['o-coke', 'o-fries'])], askMore);
    expect(c.items).toEqual(['deal-3 ×1 [o-coke, o-fries]']);
  });
});
