import { describe, expect, it } from 'vitest';
import {
  asksAboutAllergens,
  createConversation,
  parseActions,
  processTurn,
} from '../src/domain/engine';
import { resolveItemMention } from '../src/domain/menu-resolver';
import { sellableCatalog } from '../src/shared/deals';
import { describeCorrection, describeStep } from '../src/shared/explain';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Company,
  Deal,
  DealChoiceGroup,
  ModelResponse,
  Product,
} from '../src/shared/types';

// Bun & Co. is open all day in Asia/Karachi. Tuesday 20 October 2026, local times at +05:00.
const company = seedCompanies[1]!;
const at = (local: string, date = '2026-10-20') =>
  new Date(`${date}T${local}:00+05:00`).toISOString();
const dish = (id: string, name: string, extra: Partial<Product> = {}): Product => ({
  id,
  companyId: company.id,
  name,
  description: '',
  category: 'Drinks',
  price: 15000,
  available: true,
  emoji: '🥤',
  aliases: [],
  variants: [],
  modifiers: [],
  ...extra,
});
const seed = seedProducts.filter((p) => p.companyId === company.id);
const smash = seed.find((p) => p.name === 'Classic Smash')!;
const crispy = seed.find((p) => p.name === 'Crispy Chicken')!;
const fries = seed.find((p) => p.name === 'Loaded Fries')!;
const zinger = dish('zinger-burger', 'Zinger Burger', { category: 'Burgers', aliases: ['zinger'] });
const sprite345 = dish('sprite-345', 'Sprite 345ml', { aliases: ['sprite'] });
const sprite15 = dish('sprite-15', 'Sprite 1.5L', { aliases: ['sprite'] });
const dishes = [...seed, zinger, sprite345, sprite15];
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
const deal = (id: string, name: string, over: Partial<Deal> = {}): Deal => ({
  id,
  companyId: company.id,
  name,
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
  choices: [drink],
  available: true,
  position: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const weekdayLunch = { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' };
const deal1 = deal('deal-1', 'Deal 1', { position: 1 });
const deal2 = deal('deal-2', 'Deal 2', { position: 2, choices: [] });
const deal3 = deal('deal-3', 'Deal 3', { position: 3, choices: [drink, side] });
const zingerDeal = deal('zinger-deal', 'Zinger Deal', { position: 4, choices: [] });
const lunchDeal = deal('lunch-deal', 'Lunch Deal', { position: 5, schedule: weekdayLunch });
const deals = [deal1, deal2, deal3, zingerDeal, lunchDeal];
// The menu as the bot sells it at a local time: every deal, paused and ended ones refusable.
const catalog = (local = '13:00', list: Deal[] = deals, products: Product[] = dishes) =>
  sellableCatalog(company, products, list, at(local), { all: true });
const fresh = () => createConversation(company.id, '923001234567', 'whatsapp', at('12:00'));
const show = (actions: BotAction[]) =>
  actions.map((a) =>
    a.type === 'add_item'
      ? `add ${a.productId} ×${a.quantity}${a.modifierIds?.length ? ` [${a.modifierIds.join(', ')}]` : ''}`
      : a.type === 'clarify_item'
        ? `which ${a.candidateProductIds.join(' | ')} ×${a.quantity}`
        : a.type === 'remove_item'
          ? `remove ${a.productId}`
          : a.type === 'menu'
            ? `menu ${a.query ?? ''}`.trim()
            : a.type,
  );
const parse = (text: string, products = catalog(), who: Company = company) =>
  show(parseActions(who, products, fresh(), text));
// A chat whose turns run through the engine; with `actions` they are the AI's proposal.
function chat(who: Company = company) {
  let conversation = createConversation(who.id, '923001234567', 'whatsapp', at('12:00'));
  let n = 0;
  return {
    get conversation() {
      return conversation;
    },
    send(
      text: string,
      opts: {
        local?: string;
        products?: Product[];
        actions?: BotAction[];
        response?: ModelResponse;
      } = {},
    ) {
      const result = processTurn(
        who,
        opts.products ?? catalog(opts.local),
        conversation,
        { messageId: `m${++n}`, text, now: at(opts.local ?? '13:00') },
        opts.actions,
        opts.response,
      );
      conversation = result.conversation;
      return result;
    },
  };
}
const lines = (c: ReturnType<typeof chat>) =>
  c.conversation.cart.items.map(
    (item) =>
      `${item.productId} ×${item.quantity}${item.modifierIds.length ? ` [${item.modifierIds.join(', ')}]` : ''}`,
  );

describe('deals are found by their own names, apart from dishes', () => {
  it('reads a numbered deal’s number as its name, never as a count', () => {
    expect(parse('deal 2')).toEqual(['add deal-2 ×1']);
    expect(parse('mujhe deal 2 chahiye')).toEqual(['add deal-2 ×1']);
    expect(parse('2 deal 3')).toEqual(['add deal-3 ×2']);
    expect(parse('deal 2 aur deal 3')).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
    expect(parse('deal 2, deal 3')).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
    expect(parse('deal 1 x2')).toEqual(['add deal-1 ×2']);
    expect(resolveItemMention(catalog(), company.id, 'deal 3')).toMatchObject({
      kind: 'unique',
      product: { id: 'deal-3' },
      quantity: 1,
    });
    // "deal 12" is no deal here, and never Deal 1.
    expect(parse('deal 12')).not.toContain('add deal-1 ×1');
    expect(resolveItemMention(catalog(), company.id, 'deal 12').kind).toBe('none');
  });

  it('refuses a deal that ended or is paused by its own name instead of adding another deal', () => {
    const ended = deal('deal-1', 'Deal 1', {
      schedule: {
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        endDate: '2026-10-01',
      },
    });
    const products = catalog('13:00', [ended, deal2]);
    for (const text of ['deal 1', 'mujhe deal 1 chahiye', '2 deal 1'])
      expect(parse(text, products)[0]).toMatch(/^add deal-1 /);
    const c = chat();
    const result = c.send('deal 1', { products });
    expect(result.reply).toBe('Deal 1 has ended.');
    expect(result.traces).toEqual(['add_item', 'deal_not_on', 'validation_failed:add_item']);
    expect(c.conversation.cart.items).toEqual([]);
    const paused = catalog('13:00', [{ ...deal1, available: false }, deal2]);
    expect(chat().send('deal 1 with coke', { products: paused }).reply).toBe(
      'Deal 1 is not available right now.',
    );
  });

  it('keeps "biryani" the biryani beside a Biryani Deal, and "biryani deal" the deal', () => {
    const dastarkhwan = seedCompanies[0]!;
    const own = seedProducts.filter((p) => p.companyId === dastarkhwan.id);
    const chickenBiryani = own.find((p) => p.name === 'Chicken Biryani')!;
    const biryaniDeal = {
      ...deal('biryani-deal', 'Biryani Deal', { choices: [] }),
      companyId: dastarkhwan.id,
    };
    const products = sellableCatalog(dastarkhwan, own, [biryaniDeal], at('13:00'), { all: true });
    expect(parse('1 biryani', products, dastarkhwan)).toEqual([`add ${chickenBiryani.id} ×1`]);
    expect(parse('biryani', products, dastarkhwan)).toEqual([`add ${chickenBiryani.id} ×1`]);
    expect(parse('2 biryani chahiye', products, dastarkhwan)).toEqual([
      `add ${chickenBiryani.id} ×2`,
    ]);
    expect(parse('biryanni', products, dastarkhwan)).toEqual([`add ${chickenBiryani.id} ×1`]);
    expect(parse('1 biryani deal', products, dastarkhwan)).toEqual(['add biryani-deal ×1']);
    // The AI's correct add is not turned into a "which one?".
    const c = chat(dastarkhwan);
    const result = c.send('1 biryani', {
      products,
      actions: [{ type: 'add_item', productId: chickenBiryani.id, quantity: 1, modifierIds: [] }],
      response: { text: 'Anything else?', askFor: 'anything_else' },
    });
    expect(result.traces).not.toContain('ambiguous_addition_prevented');
    expect(lines(c)).toEqual([`${chickenBiryani.id} ×1`]);
  });

  it('never reads "deal" as "daal" on a menu without deals', () => {
    const dastarkhwan = seedCompanies[0]!;
    const own = seedProducts.filter((p) => p.companyId === dastarkhwan.id);
    const daal = own.find((p) => p.name === 'Daal Makhani')!;
    for (const text of ['deal chahiye', 'lunch deal', 'midnight deal dena', 'deals', 'deal'])
      expect(resolveItemMention(own, dastarkhwan.id, text).kind).toBe('none');
    for (const text of ['koi deal hai?', 'deal chahiye', 'lunch deal', 'deals?'])
      expect(parse(text, own, dastarkhwan)).not.toContain(`add ${daal.id} ×1`);
    expect(parse('koi deal hai?', own, dastarkhwan)).toEqual(['menu deals']);
    // Daal itself, and a typo of it, still find the daal.
    expect(parse('1 daal', own, dastarkhwan)).toEqual([`add ${daal.id} ×1`]);
    expect(parse('daal makhni', own, dastarkhwan)).toEqual([`add ${daal.id} ×1`]);
    const result = chat(dastarkhwan).send('koi deal hai?', { products: own });
    expect(result.reply).toContain('We couldn’t find “deals” on the menu. Here is our menu:');
    expect(result.conversation.cart.items).toEqual([]);
  });

  it('reads a name inside a longer name as that longer name, each time it is written', () => {
    // On the Bun & Co. menu as it is: "chicken burger" is Crispy Chicken, not also a burger.
    expect(parse('1 chicken burger', seed)).toEqual([`add ${crispy.id} ×1`]);
    expect(parse('1 chicken burger aur 1 burger', seed)).toEqual([
      `add ${crispy.id} ×1`,
      `add ${smash.id} ×1`,
    ]);
    expect(parse('1 chicken burger aur 2 burger', seed)).toEqual([
      `add ${crispy.id} ×1`,
      `add ${smash.id} ×2`,
    ]);
    // A deal named after a dish is the deal; the dish named again is the dish.
    expect(parse('1 zinger deal')).toEqual(['add zinger-deal ×1']);
    expect(parse('1 zinger deal and 2 zinger')).toEqual([
      'add zinger-deal ×1',
      'add zinger-burger ×2',
    ]);
    expect(parse('2 zinger aur 1 zinger deal')).toEqual([
      'add zinger-burger ×2',
      'add zinger-deal ×1',
    ]);
    const c = chat();
    c.send('1 zinger deal and 2 zinger');
    expect(lines(c)).toEqual(['zinger-deal ×1', 'zinger-burger ×2']);
    expect(parse('remove zinger deal')).toEqual(['remove zinger-deal']);
    c.send('remove zinger deal');
    expect(lines(c)).toEqual(['zinger-burger ×2']);
  });

  it.each([
    'koi deal hai?',
    'deal hai kya',
    'any deals?',
    'what deals do you have',
    'deals?',
    'deals',
    'deals dikhao',
    'کوئی ڈیل ہے؟',
    'ڈیلز',
  ])('answers the deal question “%s” with the deals, adding nothing', (text) => {
    expect(parse(text)).toEqual(['menu deals']);
    const result = chat().send(text);
    expect(result.reply).toContain('🎁 Deal 1 — Rs. 799');
    expect(result.conversation.cart.items).toEqual([]);
  });

  it('shows one named deal asked about, and asks which deal for "deal chahiye"', () => {
    expect(parse('deal 1 hai?')).toEqual(['menu Deal 1']);
    expect(parse('kya zinger deal milegi')).toEqual(['menu Zinger Deal']);
    expect(parse('deal chahiye')).toEqual([
      'which deal-1 | deal-2 | deal-3 | zinger-deal | lunch-deal ×1',
    ]);
    const result = chat().send('deal chahiye', { local: '16:00' });
    expect(result.reply).toBe(
      [
        'Aap kaun sa lena chahenge?',
        '1. Deal 1 — Rs. 799',
        '2. Deal 2 — Rs. 799',
        '3. Deal 3 — Rs. 799',
        '4. Zinger Deal — Rs. 799',
      ].join('\n'),
    );
    // With one deal on, that deal is the one: its choice is asked.
    const one = chat().send('ek deal dena', { products: catalog('13:00', [deal1]) });
    expect(one.reply).toContain('Choose Drink for Deal 1:');
  });

  it('takes the options named with a deal as its picks, never as other dishes', () => {
    expect(parse('deal 1 with sprite')).toEqual(['add deal-1 ×1 [o-sprite]']);
    expect(parse('deal 1 sprite wala')).toEqual(['add deal-1 ×1 [o-sprite]']);
    expect(parse('deal 3 with coke fries')).toEqual(['add deal-3 ×1 [o-coke, o-fries]']);
    // A pick of its own count, or in its own part of the message, is an item.
    expect(parse('deal 1 aur ek sprite')).toEqual([
      'add deal-1 ×1',
      'which sprite-15 | sprite-345 ×1',
    ]);
    expect(parse('deal 1 with 2 lemon mint', catalog())).toEqual([
      'add deal-1 ×1',
      `add ${seed.find((p) => p.name === 'Lemon Mint')!.id} ×2`,
    ]);
    // The longer option name wins: "diet coke" is not Coke.
    const diet = deal('deal-1', 'Deal 1', {
      choices: [
        {
          ...drink,
          options: [...drink.options, { id: 'o-diet', name: 'Diet Coke', price: 2000 }],
        },
      ],
    });
    expect(parse('deal 1 with diet coke', catalog('13:00', [diet]))).toEqual([
      'add deal-1 ×1 [o-diet]',
    ]);
    const c = chat();
    const result = c.send('deal 1 with sprite');
    expect(result.reply).toBe(
      'Added 1 × Deal 1 (Drink: Sprite). Add anything else, or send “review”.',
    );
    expect(lines(c)).toEqual(['deal-1 ×1 [o-sprite]']);
  });

  it('leaves a deal named in Urdu letters to the AI rather than reading it as a question', () => {
    const c = chat();
    const result = c.send('لنچ ڈیل', {
      actions: [
        { type: 'add_item', productId: 'lunch-deal', quantity: 1, modifierIds: ['o-coke'] },
      ],
      response: { text: '', askFor: 'none' },
    });
    expect(result.traces).not.toContain('browse_cart_mutation_prevented');
    expect(lines(c)).toEqual(['lunch-deal ×1 [o-coke]']);
  });
});

describe('the chat menu with deals', () => {
  const soldOut = deal('sold-out', 'Fries Deal', {
    position: 6,
    choices: [],
    items: [{ name: 'Loaded Fries', quantity: 2, productId: fries.id }],
  });
  const paused = deal('paused', 'Family Deal', { position: 7, available: false });
  const ended = deal('ended', 'Eid Deal', {
    position: 8,
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00', endDate: '2026-10-01' },
  });
  const all = [...deals, soldOut, paused, ended];
  const products = (local: string) =>
    catalog(
      local,
      all,
      dishes.map((p) => (p.id === fries.id ? { ...p, available: false } : p)),
    );

  it('lists up to three deals that are on first, one line each, then the dishes', () => {
    const reply = chat().send('menu', { products: products('16:00') }).reply;
    const [title, ...rest] = reply.split('\n');
    expect(title).toBe('Bun & Co.');
    expect(rest.slice(0, 4)).toEqual([
      '🎁 Deal 1 — Rs. 799: Zinger burger + Fries + Drink',
      '🎁 Deal 2 — Rs. 799: Zinger burger + Fries + Drink',
      '🎁 Deal 3 — Rs. 799: Zinger burger + Fries + Drink',
      // Zinger Deal (on) and Lunch Deal (later today) are not shown here.
      '…and 2 more deals. Send “deals” to see them all.',
    ]);
    expect(rest[4]).toBe('🍔 Classic Smash — Rs. 690');
    for (const name of ['Fries Deal', 'Family Deal', 'Eid Deal']) expect(reply).not.toContain(name);
    const urdu = chat().send('مینو', { products: products('16:00') }).reply;
    expect(urdu).toContain('…اور 2 مزید ڈیلز۔ سب دیکھنے کے لیے “deals” لکھیں۔');
  });

  it('shows every deal that is on or later in detail for "deals"', () => {
    const reply = chat().send('deals', { products: products('16:00') }).reply;
    expect(reply).toContain(
      [
        '🎁 Deal 1 — Rs. 799 (save Rs. 250)',
        '  Zinger burger + Fries + Drink',
        '  Drink: Coke, Sprite, Fanta (+Rs. 50)',
      ].join('\n'),
    );
    expect(reply).toContain('  Side: Fries, Wings (+Rs. 100)');
    expect(reply).toContain('🎁 Lunch Deal — Rs. 799 (save Rs. 250) · On Mon–Fri 12:00–15:00');
    expect(reply).toContain(
      '🎁 Fries Deal — Rs. 799 (save Rs. 250) · Unavailable\n  2 × Loaded Fries',
    );
    expect(reply).not.toContain('Family Deal');
    expect(reply).not.toContain('Eid Deal');
    const urdu = chat().send('ڈیلز', { products: products('16:00') }).reply;
    expect(urdu).toContain(
      '🎁 Lunch Deal — Rs. 799 (Rs. 250 کی بچت) · پیر تا جمعہ 12:00–15:00 دستیاب',
    );
    const roman = chat().send('mujhe deals dikhao', { products: products('16:00') }).reply;
    expect(roman).toContain('· Monday–Friday 12:00–15:00 available');
  });

  it('says when no deal is on, then shows the menu', () => {
    const reply = chat().send('deals?', { products: catalog('13:00', [paused, ended]) }).reply;
    expect(reply.startsWith('We have no deals on right now.\n\nBun & Co.\n🍔 Classic Smash')).toBe(
      true,
    );
  });

  it('lists the menu’s own "Deals" section after the deals, and alone without deals', () => {
    const family = dish('family', 'Family Deal', {
      category: 'Deals',
      price: 249900,
      emoji: '🍱',
      description: 'Four burgers and fries.',
    });
    const withDeals = chat().send('deals', {
      products: catalog('13:00', [deal1], [...dishes, family]),
    });
    expect(withDeals.reply).toContain(
      '  Drink: Coke, Sprite, Fanta (+Rs. 50)\n🍱 Family Deal — Rs. 2,499',
    );
    // A business without deals: the AI's "deals" search finds that section as before.
    const before = chat().send('any deals?', {
      products: [...dishes, family],
      actions: [{ type: 'menu', query: 'deals' }],
      response: { text: 'Here you go:', askFor: 'none' },
    });
    expect(before.reply).toBe('Here you go:\n\nBun & Co.\n🍱 Family Deal — Rs. 2,499');
  });
});

describe('a deal that is not on', () => {
  it.each([
    ['lunch deal with coke', 'Lunch Deal is only available Mon–Fri 12:00–15:00.'],
    ['لنچ ڈیل چاہیے', 'Lunch Deal صرف پیر تا جمعہ 12:00–15:00 دستیاب ہے۔'],
    ['mujhe lunch deal chahiye', 'Lunch Deal sirf Monday–Friday 12:00–15:00 available hai.'],
  ])('is refused outside its times: “%s”', (text, refusal) => {
    const c = chat();
    const urduName = text.startsWith('لنچ');
    const result = c.send(text, {
      local: '16:00',
      ...(urduName && {
        actions: [{ type: 'add_item', productId: 'lunch-deal', quantity: 1, modifierIds: [] }],
        response: { text: 'Done, added!', askFor: 'none' },
      }),
    });
    expect(result.reply).toBe(refusal);
    expect(result.traces).toContain('deal_not_on');
    expect(result.traces).toContain('validation_failed:add_item');
    expect(c.conversation.cart.items).toEqual([]);
  });

  it('is refused when sold out, paused or ended, in the chat’s language', () => {
    const soldOut = deal('fries-deal', 'Fries Deal', {
      choices: [],
      items: [{ name: 'Loaded Fries', quantity: 2, productId: fries.id }],
    });
    const products = catalog(
      '13:00',
      [soldOut, { ...deal1, available: false }],
      dishes.map((p) => (p.id === fries.id ? { ...p, available: false } : p)),
    );
    expect(chat().send('fries deal', { products }).reply).toBe('Fries Deal is sold out right now.');
    expect(chat().send('mujhe fries deal chahiye', { products }).reply).toBe(
      'Fries Deal abhi sold out hai.',
    );
    expect(chat().send('mujhe deal 1 chahiye', { products }).reply).toBe(
      'Deal 1 abhi available nahi hai.',
    );
  });

  it('in the cart is named, with how to take it out, before anything else is added', () => {
    const c = chat();
    c.send('lunch deal with sprite', { local: '14:30' });
    const blocked = c.send('add 1 loaded fries', { local: '15:30' });
    expect(blocked.reply).toBe(
      'Lunch Deal in your cart is only available Mon–Fri 12:00–15:00. Send “remove Lunch Deal” to take it out, then carry on.',
    );
    expect(blocked.traces).toEqual(['add_item', 'deal_not_on', 'validation_failed:add_item']);
    const urdu = c.send('ایک فرائز', { local: '15:31' });
    expect(urdu.reply).toBe(
      'آپ کی ٹوکری میں Lunch Deal صرف پیر تا جمعہ 12:00–15:00 دستیاب ہے۔ اسے نکالنے کے لیے “remove Lunch Deal” لکھیں، پھر آرڈر جاری رکھیں۔',
    );
    expect(c.send('remove lunch deal', { local: '15:32' }).traces).toEqual(['remove_item']);
    c.send('1 loaded fries', { local: '15:33' });
    expect(lines(c)).toEqual([`${fries.id} ×1`]);
  });

  it('cannot be confirmed after its times end: reviewed at 14:58, confirmed at 15:01', () => {
    const c = chat();
    c.send('lunch deal with sprite', { local: '14:50' });
    c.send('pickup, my name is Ali', { local: '14:55' });
    const shown = c.send('review', { local: '14:58' });
    expect(shown.reply).toContain('1 × Lunch Deal (Drink: Sprite) — Rs. 799');
    expect(c.conversation.cart.status).toBe('awaiting_confirmation');
    const late = c.send('confirm', { local: '15:01' });
    expect(late.order).toBeUndefined();
    expect(late.reply).toBe(
      'Lunch Deal in your cart is only available Mon–Fri 12:00–15:00. Send “remove Lunch Deal” to take it out, then carry on.',
    );
    expect(late.traces).toEqual(['confirm', 'deal_not_on', 'validation_failed:confirm']);
    expect(c.conversation.cart.status).toBe('building');
    expect(c.conversation.cart.quoteHash).toBeUndefined();
    // The cart still shows it, marked, with the same way out.
    const recap = c.send('show my order', { local: '15:02' });
    expect(recap.reply).toBe(
      'Your order so far:\n1 × Lunch Deal · not on now\n\nLunch Deal in your cart is only available Mon–Fri 12:00–15:00. Send “remove Lunch Deal” to take it out, then carry on.',
    );
    // Confirmed in its times, the same cart is placed.
    const onTime = chat();
    onTime.send('lunch deal with sprite', { local: '14:50' });
    onTime.send('pickup, my name is Ali', { local: '14:55' });
    onTime.send('review', { local: '14:58' });
    expect(onTime.send('confirm', { local: '14:59' }).order?.items[0]).toMatchObject({
      productId: 'lunch-deal',
      variant: 'Drink: Sprite',
      includes: ['1 × Zinger burger', '1 × Fries', '1 × Drink'],
    });
  });
});

describe('deal lines in the review and the "which one?" list', () => {
  it('shows what a deal includes under it while the review fits WhatsApp’s 1024 characters', () => {
    const c = chat();
    c.send('deal 1 with coke', { local: '13:00' });
    const reply = c.send('pickup, my name is Ali').reply;
    expect(reply).toContain(
      '1 × Deal 1 (Drink: Coke) — Rs. 799\n   Zinger burger + Fries + Drink\n',
    );
    const big = deal('big', 'Big Deal', {
      choices: [],
      items: Array.from({ length: 20 }, (_, i) => ({
        name: `Item number ${i + 1} of this big deal, with a long name for the review`,
        quantity: 2,
      })),
    });
    const products = catalog('13:00', [deal1, big]);
    const long = chat();
    long.send('deal 1 with coke', { products });
    long.send('big deal', { products });
    const review = long.send('pickup, my name is Ali', { products }).reply;
    expect(review).toContain('1 × Deal 1 (Drink: Coke) — Rs. 799\n1 × Big Deal — Rs. 799\n');
    expect(review).not.toContain('Item number');
    expect(review.length).toBeLessThanOrEqual(1024);
  });

  it('tells deals apart in "which one?" by price and when they are on', () => {
    const result = chat().send('x', {
      local: '16:00',
      actions: [
        { type: 'clarify_item', candidateProductIds: ['deal-1', 'lunch-deal'], quantity: 1 },
      ],
      response: { text: '', askFor: 'none' },
    });
    expect(result.reply).toBe(
      'Which one would you like?\n1. Deal 1 — Rs. 799\n2. Lunch Deal — Rs. 799 · on Mon–Fri 12:00–15:00',
    );
  });
});

describe('the AI’s wording about deals', () => {
  const answer = (text: string, who: Company = company, products = catalog()) =>
    chat(who).send('tell me about deal 1', {
      products,
      actions: [{ type: 'answer', text: '' }],
      response: { text, askFor: 'none', groundingIds: [] },
    });

  it.each([
    'Deal 1 saves you 250 today!',
    'Get 30% off on Deal 2',
    'Deal 3 mein 250 ki bachat hai',
    'اس ڈیل میں ۲۵۰ روپے کی بچت ہے',
  ])('drops a saving the AI states itself: “%s”', (text) => {
    const result = answer(text);
    expect(result.reply).not.toContain(text);
    expect(result.traces).toContain('unsafe_model_response_ignored');
  });

  it.each([
    'Deal 2 saves you money and time.',
    'You save with Deal 2.',
    'We are off on 25 December.',
    'Our chicken is 100% halal.',
  ])('keeps wording that states no saving: “%s”', (text) => {
    expect(answer(text).reply).toBe(text);
  });

  it('keeps the owner’s own saving wording, and checks nothing new without deals', () => {
    const owner: Company = {
      ...company,
      faqs: [{ question: 'Student discount?', answer: 'Students get 10% off with a card.' }],
    };
    expect(answer('Yes! Students get 10% off with a card.', owner).reply).toBe(
      'Yes! Students get 10% off with a card.',
    );
    // A business without deals: unchanged.
    expect(answer('You save 250 with the family pack.', company, dishes).reply).toBe(
      'You save 250 with the family pack.',
    );
  });

  it('treats a question about what is in a deal as an allergy question', () => {
    expect(asksAboutAllergens('is there egg in the zinger deal?')).toBe(false);
    const result = chat().send('is there egg in the zinger deal?', {
      actions: [{ type: 'answer', text: '' }],
      response: { text: 'No egg at all, enjoy!', askFor: 'none' },
    });
    expect(result.traces).toContain('allergy_question_guarded');
    expect(result.reply).not.toContain('No egg at all');
    const followUp = chat();
    followUp.send('any milk in deal 1?', { actions: [{ type: 'answer', text: '' }] });
    expect(followUp.conversation.mode).toBe('human');
    // Without a deal of that name it stays a menu question, as before.
    expect(
      chat().send('is there any fish in the dinner deal', {
        actions: [{ type: 'answer', text: '' }],
        response: { text: 'We have no fish dishes.', askFor: 'none' },
      }).traces,
    ).not.toContain('allergy_question_guarded');
  });

  it('explains the deal steps in plain words', () => {
    expect(describeStep('deal_choice_asked')).toBe('Asked for a deal’s choice');
    expect(describeStep('deal_choice_answered')).toBe('Added a deal with the customer’s choices');
    expect(describeStep('deal_not_on')).toBe('Said a deal isn’t on now');
    expect(describeCorrection('deal_choice_resolved')).toBe(
      'The customer answered the deal’s choice, so the engine added the deal with it in place of what the AI proposed.',
    );
    expect(describeCorrection('unsafe_model_response_ignored')).toBe(
      'The AI’s wording stated prices, a saving or discount, or a confirmation, so it was dropped.',
    );
  });
});
