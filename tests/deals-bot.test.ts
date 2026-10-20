import { describe, expect, it } from 'vitest';
import {
  asksAboutAllergens,
  asksForPerson,
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

  it('reads a dish inside a longer dish name as main does, and a deal’s name apart from dishes', () => {
    // Dishes are read as on main (c5704f5), deals or not: on the Bun & Co. menu "chicken burger"
    // is Crispy Chicken and also the Classic Smash's "burger" (an old issue, outside deals).
    expect(parse('1 chicken burger', seed)).toEqual([`add ${crispy.id} ×1`, `add ${smash.id} ×1`]);
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

describe('a deal word in a message that orders dishes, on a menu without deals', () => {
  const dastarkhwan = seedCompanies[0]!;
  const menu = seedProducts.filter((p) => p.companyId === dastarkhwan.id);
  const biryani = menu.find((p) => p.name === 'Chicken Biryani')!;
  const naan = menu.find((p) => p.name === 'Butter Naan')!;
  const add = (product: Product, quantity: number): BotAction => ({
    type: 'add_item',
    productId: product.id,
    quantity,
    modifierIds: [],
  });
  const delivery: BotAction = { type: 'set_details', fulfillment: 'delivery' };
  const added = (n: number) => `Added ${n} × Chicken Biryani. Add anything else, or send “review”.`;
  const unsure = 'I’m not certain about that, so I’ve asked a staff member to help.';
  const ok: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' };

  // Each is read, and answered, exactly as main (before deals) did.
  it.each<[string, BotAction[], string[], string]>([
    ['Can I get 2 chicken biryani as a meal for two?', [add(biryani, 2)], ['add_item'], added(2)],
    ['2 biryani dena, koi offer hai?', [add(biryani, 2)], ['add_item'], added(2)],
    [
      '1 chicken biryani meal bhej do',
      [add(biryani, 1)],
      ['add_item'],
      '1 × Chicken Biryani add kar diya. Aur kuch chahiye, ya “review” likhein.',
    ],
    [
      '2 biryani bhej do, family meal ke liye',
      [add(biryani, 2)],
      ['add_item'],
      '2 × Chicken Biryani add kar diya. Aur kuch chahiye, ya “review” likhein.',
    ],
    [
      '2 biryani aur 3 naan. Koi deal hai?',
      [add(biryani, 2), add(naan, 3)],
      ['add_item', 'add_item'],
      'Added 3 × Butter Naan. Add anything else, or send “review”.',
    ],
    [
      'add 2 naan, show deals',
      [add(naan, 2)],
      ['add_item'],
      'Added 2 × Butter Naan. Add anything else, or send “review”.',
    ],
    [
      '2 chicken biryani please. Do you offer delivery?',
      [add(biryani, 2), delivery],
      ['add_item', 'set_details'],
      'What name should I put on the order?',
    ],
    ['do you offer delivery?', [delivery], ['set_details'], 'What would you like to order?'],
    [
      'Do you offer cash on delivery?',
      [delivery],
      ['set_details'],
      'What would you like to order?',
    ],
    [
      'what do you offer?',
      [{ type: 'answer', text: '' }],
      ['answer', 'grounded_model_answer', 'handoff'],
      unsure,
    ],
    ['2 chicken biryani, how long will the meal take?', [add(biryani, 2)], ['add_item'], added(2)],
    [
      'whats the best meal?',
      [{ type: 'answer', text: '' }],
      ['answer', 'grounded_model_answer', 'handoff'],
      unsure,
    ],
  ])('reads “%s” as before', (text, parsed, traces, reply) => {
    const c = chat(dastarkhwan);
    expect(parseActions(dastarkhwan, menu, c.conversation, text)).toEqual(parsed);
    const result = c.send(text, { products: menu });
    expect(result.traces).toEqual(traces);
    expect(result.reply).toBe(reply);
  });

  it.each<[string, BotAction[], string[], string]>([
    [
      'Can I get 2 chicken biryani as a meal for two?',
      [add(biryani, 2)],
      ['add_item'],
      'Added 2 × Chicken Biryani — Rs. 450 each.\nItems subtotal: Rs. 900.\n\nAnything else?',
    ],
    [
      '2 biryani aur 3 naan. Koi deal hai?',
      [add(biryani, 2), add(naan, 3)],
      ['add_item', 'add_item'],
      'Added 2 × Chicken Biryani — Rs. 450 each.\nAdded 3 × Butter Naan — Rs. 100 each.\nItems subtotal: Rs. 1,200.\n\nAnything else?',
    ],
    [
      '2 chicken biryani please. Do you offer delivery?',
      [add(biryani, 2), delivery],
      ['add_item', 'set_details'],
      'Added 2 × Chicken Biryani — Rs. 450 each.\nItems subtotal: Rs. 900.\n\nAnything else?',
    ],
    [
      'I want 2 chicken biryani. Do you offer home delivery?',
      [add(biryani, 2)],
      ['add_item'],
      'Added 2 × Chicken Biryani — Rs. 450 each.\nItems subtotal: Rs. 900.\n\nAnything else?',
    ],
  ])('keeps the AI’s order of “%s”, as before', (text, actions, traces, reply) => {
    const c = chat(dastarkhwan);
    const result = c.send(text, { products: menu, actions, response: ok });
    expect(result.traces).toEqual(traces);
    expect(result.reply).toBe(reply);
    expect(c.conversation.cart.items.map((item) => [item.productId, item.quantity])).toEqual(
      actions.flatMap((a) => (a.type === 'add_item' ? [[a.productId, a.quantity]] : [])),
    );
  });

  it('keeps the AI’s "…meal?" order at Bun & Co., as before', () => {
    const c = chat();
    const result = c.send('Can I get a crispy chicken meal?', {
      products: seed,
      actions: [add(crispy, 1)],
      response: ok,
    });
    expect(result.traces).toEqual(['add_item']);
    expect(result.reply).toBe(
      'Added 1 × Crispy Chicken — Rs. 620 each.\nItems subtotal: Rs. 620.\n\nAnything else?',
    );
  });

  it.each(['any offers?', 'deal hai kya', 'deals dikhao', 'koi offer hai', 'any combos'])(
    'still answers the deal question “%s” with the menu, adding nothing',
    (text) => {
      const c = chat(dastarkhwan);
      expect(parseActions(dastarkhwan, menu, c.conversation, text)).toEqual([
        { type: 'menu', query: 'deals' },
      ]);
      const result = c.send(text, { products: menu });
      expect(result.reply).toContain('We couldn’t find “deals” on the menu. Here is our menu:');
      expect(result.conversation.cart.items).toEqual([]);
    },
  );
});

describe('"meal" and "combo" as words of dishes’ names, on a menu without deals', () => {
  const menu = [
    dish('zinger', 'Zinger Burger', { category: 'Burgers' }),
    dish('chicken-burger', 'Chicken Burger', { category: 'Burgers' }),
    dish('zinger-meal', 'Zinger Meal', { category: 'Meals' }),
    dish('kids-meal', 'Kids Meal', { category: 'Meals' }),
    dish('chicken-combo', 'Chicken Combo', { category: 'Meals' }),
    dish('wrap', 'Chicken Wrap', { category: 'Wraps' }),
    dish('family-combo', 'Family Combo', { category: 'Meals' }),
    dish('fries', 'Fries', { category: 'Sides' }),
  ];
  // Each is read, and answered, exactly as main (before deals) did.
  it.each([
    [
      'meal',
      ['which zinger-meal | kids-meal ×1'],
      'Which one would you like?\n1. Zinger Meal\n2. Kids Meal',
    ],
    [
      'meals?',
      ['which kids-meal | zinger-meal ×1'],
      'Which one would you like?\n1. Kids Meal\n2. Zinger Meal',
    ],
    [
      'koi meal hai?',
      ['which kids-meal | zinger-meal ×1'],
      'Which one would you like?\n1. Kids Meal\n2. Zinger Meal',
    ],
    [
      'combo',
      ['which chicken-combo | family-combo ×1'],
      'Which one would you like?\n1. Chicken Combo\n2. Family Combo',
    ],
    [
      'any combos?',
      ['which chicken-combo | family-combo ×1'],
      'Which one would you like?\n1. Chicken Combo\n2. Family Combo',
    ],
    [
      '3 zinger meals',
      ['add zinger-meal ×3'],
      'Added 3 × Zinger Meal. Add anything else, or send “review”.',
    ],
    [
      '2 zinger meals?',
      ['add zinger-meal ×2'],
      'Added 2 × Zinger Meal. Add anything else, or send “review”.',
    ],
    [
      '2 chicken combos',
      ['add chicken-combo ×2'],
      'Added 2 × Chicken Combo. Add anything else, or send “review”.',
    ],
    [
      'family combos?',
      ['add family-combo ×1'],
      'Added 1 × Family Combo. Add anything else, or send “review”.',
    ],
  ])('reads “%s” as before', (text, parsed, reply) => {
    expect(parse(text, menu)).toEqual(parsed);
    expect(chat().send(text, { products: menu }).reply).toBe(reply);
  });

  it('keeps the AI’s "which meal?" and its add of the meals named', () => {
    const which = chat().send('meal', {
      products: menu,
      actions: [
        { type: 'clarify_item', candidateProductIds: ['zinger-meal', 'kids-meal'], quantity: 1 },
      ],
      response: { text: 'Anything else?', askFor: 'anything_else' },
    });
    expect(which.traces).toEqual(['clarify_item', 'invalid_model_prompt_ignored']);
    expect(which.reply).toBe('Which one would you like?\n1. Zinger Meal\n2. Kids Meal');
    const c = chat();
    const result = c.send('2 zinger meals?', {
      products: menu,
      actions: [{ type: 'add_item', productId: 'zinger-meal', quantity: 2, modifierIds: [] }],
      response: { text: 'Anything else?', askFor: 'anything_else' },
    });
    expect(result.traces).toEqual(['add_item']);
    expect(lines(c)).toEqual(['zinger-meal ×2']);
  });
});

describe('a deal word beside dishes, on a menu with deals', () => {
  const add = (product: Product, quantity: number): BotAction => ({
    type: 'add_item',
    productId: product.id,
    quantity,
    modifierIds: [],
  });

  it('adds the dishes named, and asks which deal only for a deal ordered in its own part', () => {
    // "zinger": "zinger burger" would also be the Classic Smash's "burger", as on main.
    expect(parse('2 zinger aur ek deal chahiye')).toEqual([
      'add zinger-burger ×2',
      'which deal-1 | deal-2 | deal-3 | zinger-deal | lunch-deal ×1',
    ]);
    expect(parse('2 zinger, koi deal hai?')).toEqual(['add zinger-burger ×2']);
    expect(parse('2 loaded fries please, any other deals?')).toEqual([`add ${fries.id} ×2`]);
    expect(parse('Can I get 2 loaded fries as a meal for two?')).toEqual([`add ${fries.id} ×2`]);
    expect(parse('I want 2 loaded fries. Do you offer home delivery?')).toEqual([
      `add ${fries.id} ×2`,
      'set_details',
    ]);
    // With no dish named, a deal word still asks for the deals or orders one.
    expect(parse('koi deal hai?')).toEqual(['menu deals']);
    expect(parse('deal mangwana hai')).toEqual([
      'which deal-1 | deal-2 | deal-3 | zinger-deal | lunch-deal ×1',
    ]);
  });

  it('keeps the AI’s additions beside its "which deal?" and its answer about the deals', () => {
    const ok: ModelResponse = { text: 'Sure!', askFor: 'none' };
    const whichDeal: BotAction = {
      type: 'clarify_item',
      candidateProductIds: ['deal-1', 'deal-2', 'deal-3', 'zinger-deal', 'lunch-deal'],
      quantity: 1,
    };
    // Also where the parser finds only the dish: its "which deal?" is not that dish again.
    for (const [text, dish] of [
      ['2 zinger burger aur ek deal chahiye', zinger],
      ['I want 2 loaded fries and a deal', fries],
    ] as const) {
      const c = chat();
      const result = c.send(text, { actions: [add(dish, 2), whichDeal], response: ok });
      expect(result.traces).toEqual(['add_item', 'clarify_item']);
      expect(lines(c)).toEqual([`${dish.id} ×2`]);
      expect(c.conversation.pendingItemChoice?.candidateProductIds).toHaveLength(5);
    }
    for (const [text, actions] of [
      ['2 loaded fries please, any other deals?', [add(fries, 2)]],
      ['I want 2 loaded fries. Do you offer home delivery?', [add(fries, 2)]],
      [
        'deal 1 aur 2 fries. deal 2 hai?',
        [
          { type: 'add_item', productId: 'deal-1', quantity: 1, modifierIds: ['o-coke'] },
          add(fries, 2),
        ],
      ],
    ] as [string, BotAction[]][]) {
      const order = chat();
      const turn = order.send(text, { actions, response: ok });
      expect(turn.traces).not.toContain('browse_cart_mutation_prevented');
      expect(lines(order)).toEqual(
        actions.flatMap((a) =>
          a.type === 'add_item'
            ? [`${a.productId} ×${a.quantity}${a.modifierIds?.length ? ` [${a.modifierIds}]` : ''}`]
            : [],
        ),
      );
    }
  });

  it('keeps what the AI read beside a question about the deals, deals included', () => {
    const ok: ModelResponse = { text: 'Sure!', askFor: 'none' };
    const whichDeal: BotAction = {
      type: 'clarify_item',
      candidateProductIds: ['deal-1', 'deal-2', 'deal-3', 'zinger-deal'],
      quantity: 1,
    };
    // Urdu script the parser cannot read as a dish: it reads only the deals question, which
    // takes the place of nothing the AI proposed, its "which deal?" or its deal either.
    for (const [text, actions, cart] of [
      ['دو زنگر اور کوئی ڈیل ہے؟', [add(zinger, 2)], ['zinger-burger ×2']],
      ['2 زنگر بھیج دیں، کوئی ڈیل بھی ہے؟', [add(zinger, 2)], ['zinger-burger ×2']],
      ['2 زنگر اور ایک ڈیل بھیج دیں', [add(zinger, 2), whichDeal], ['zinger-burger ×2']],
      [
        '2 زنگر، کوئی ڈیل ہے؟',
        [add(zinger, 2), { type: 'add_item', productId: 'deal-2', quantity: 1, modifierIds: [] }],
        ['zinger-burger ×2', 'deal-2 ×1'],
      ],
    ] as [string, BotAction[], string[]][]) {
      expect(parse(text)).toEqual(['menu deals']);
      const c = chat();
      const result = c.send(text, { actions, response: ok });
      expect(lines(c)).toEqual(cart);
      expect(result.reply).toContain('2 × Zinger Burger');
      expect(result.traces).not.toContain('browse_cart_mutation_prevented');
      expect(c.conversation.pendingItemChoice?.candidateProductIds).toEqual(
        actions.includes(whichDeal) ? whichDeal.candidateProductIds : undefined,
      );
    }
    // A question only about the deals adds nothing the AI proposed.
    const asked = chat();
    const only = asked.send('کوئی ڈیل ہے؟', { actions: [add(zinger, 1)], response: ok });
    expect(only.traces).toContain('browse_cart_mutation_prevented');
    expect(lines(asked)).toEqual([]);
  });
});

describe('a named deal in a statement that ends in "hai"', () => {
  it.each([
    ['deal 2, mera naam Ali hai', ['add deal-2 ×1', 'set_details']],
    ['2 zinger deal bhej do, address gulberg hai', ['add zinger-deal ×2']],
    ['deal 2 bhej dein, ghar DHA phase 5 mein hai', ['add deal-2 ×1']],
    ['deal 2 pickup karna hai', ['add deal-2 ×1', 'set_details']],
    ['deal 2 mangwani hai', ['add deal-2 ×1']],
    ['deal 2 mangwani hai?', ['add deal-2 ×1']],
    ['ek deal 2 aur ek zinger deal, jaldi hai', ['add deal-2 ×1', 'add zinger-deal ×1']],
    ['ڈیل 2، میرا نام علی ہے', ['add deal-2 ×1', 'set_details']],
  ])('orders it: “%s”', (text, parsed) => {
    expect(parse(text)).toEqual(parsed);
  });

  it.each([
    ['deal 2 hai', 'menu Deal 2'],
    ['deal 2 hai?', 'menu Deal 2'],
    ['deal 2 hai kya', 'menu Deal 2'],
    ['zinger deal milegi', 'menu Zinger Deal'],
    ['deal 2 available hai', 'menu Deal 2'],
    ['ڈیل 2 ہے؟', 'menu Deal 2'],
  ])('still shows the deal asked about: “%s”', (text, shown) => {
    expect(parse(text)).toEqual([shown]);
  });

  it('keeps the AI’s add of the deal and the details given with it', () => {
    const c = chat();
    const result = c.send('deal 2, pickup, mera naam Ali hai', {
      actions: [
        { type: 'add_item', productId: 'deal-2', quantity: 1, modifierIds: [] },
        { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
      ],
      response: { text: 'Thanks Ali! Anything else?', askFor: 'anything_else' },
    });
    expect(result.traces).toEqual(['add_item', 'set_details']);
    expect(lines(c)).toEqual(['deal-2 ×1']);
    expect(c.conversation.cart).toMatchObject({ fulfillment: 'pickup', customerName: 'Ali' });
  });
});

describe('a deal whose name holds a question word or "person"', () => {
  const half = deal('half', 'Half Price Tuesday');
  const always = deal('always', 'Always Available Combo', { choices: [] });
  const urdu = deal('urdu', 'قیمت ڈیل', { choices: [] });
  const products = catalog('13:00', [half, always, urdu]);

  it('is added by its name, from Test your bot’s Add button and with the AI', () => {
    // What the Add button sends for it (Conversations addText).
    const local = chat();
    expect(local.send('Add 1 Half Price Tuesday with Sprite', { products }).reply).toBe(
      'Added 1 × Half Price Tuesday (Drink: Sprite). Add anything else, or send “review”.',
    );
    expect(lines(local)).toEqual(['half ×1 [o-sprite]']);
    const ai = chat();
    const result = ai.send('Add 1 Half Price Tuesday with Sprite', {
      products,
      actions: [{ type: 'add_item', productId: 'half', quantity: 1, modifierIds: ['o-sprite'] }],
      response: { text: '', askFor: 'none' },
    });
    expect(result.traces).toEqual(['add_item']);
    expect(lines(ai)).toEqual(['half ×1 [o-sprite]']);
    expect(parse('1 always available combo', products)).toEqual(['add always ×1']);
    expect(parse('1 قیمت ڈیل', products)).toEqual(['add urdu ×1']);
  });

  it('still shows it when asked about its price or whether it is on', () => {
    expect(parse('how much is half price tuesday', products)).toEqual(['menu Half Price Tuesday']);
    expect(parse('half price tuesday price?', products)).toEqual(['menu Half Price Tuesday']);
    expect(parse('is always available combo available?', products)).toEqual([
      'menu Always Available Combo',
    ]);
  });

  it('reads "2 Person Deal" as the deal, never as asking for a person', () => {
    const people = catalog('13:00', [
      deal('two-person', '2 Person Deal', { choices: [] }),
      deal('four-person', '4 Person Deal', { choices: [] }),
    ]);
    expect(parse('Add 1 2 Person Deal', people)).toEqual(['add two-person ×1']);
    expect(parse('2 person deal', people)).toEqual(['add two-person ×1']);
    expect(parse('ek 4 person deal', people)).toEqual(['add four-person ×1']);
    expect(parse('I want to talk to a person', people)).toEqual(['handoff']);
    expect(asksForPerson('2 person deal chahiye', people)).toBe(false);
    expect(asksForPerson('two 2 person deals', people)).toBe(false);
    expect(asksForPerson('2 person deal, aur staff se baat', people)).toBe(true);
    // Without that deal, as before.
    expect(asksForPerson('2 person deal chahiye')).toBe(true);
    // A chat paused for staff is taken back by the bot later, unless a person was asked for.
    const paused = {
      ...createConversation(company.id, '923001234567', 'whatsapp', at('12:00')),
      mode: 'human' as const,
      botPausedAt: at('12:55'),
    };
    const send = (text: string) =>
      processTurn(company, people, paused, { messageId: text, text, now: at('13:00') })
        .conversation;
    expect(send('2 person deal chahiye').botPausedAt).toBe(at('12:55'));
    expect(send('I need a person').botPausedAt).toBeUndefined();
  });
});

describe('numbered deals named together: "deal 2 and 3"', () => {
  const numbered = [1, 2, 3, 4, 5].map((k) =>
    deal(`deal-${k}`, `Deal ${k}`, { position: k, choices: [] }),
  );
  const products = catalog('13:00', numbered);

  it.each([
    'deal 2 and 3',
    'deal 2 aur 3',
    'deal 2 & 3',
    'deal 2, 3',
    'mujhe deal 2 aur 3 chahiye',
    'deals 2 and 3',
  ])('reads “%s” as Deal 2 and Deal 3', (text) => {
    expect(parse(text, products)).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
  });

  it('still reads a count written after a deal, and a number before another dish', () => {
    expect(parse('deal 1, 2, 3 aur 4', products)).toEqual([
      'add deal-1 ×1',
      'add deal-2 ×1',
      'add deal-3 ×1',
      'add deal-4 ×1',
    ]);
    expect(parse('deal 2, make it 3', products)).toEqual(['add deal-2 ×3']);
    expect(parse('deal 2 aur deal 3', products)).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
    expect(parse('deal 2 aur 3 zinger', products)).toEqual([
      'add deal-2 ×1',
      'add zinger-burger ×3',
    ]);
    // No Deal 7: the 7 is a count, as before.
    expect(parse('deal 2 aur 7', products)).toEqual(['add deal-2 ×7']);
    const c = chat();
    expect(c.send('deal 2 and 3', { products }).traces).toEqual(['add_item', 'add_item']);
    expect(lines(c)).toEqual(['deal-2 ×1', 'deal-3 ×1']);
  });

  it('keeps the AI’s two deals beside an open "which burger?"', () => {
    const c = chat();
    c.send('burger', { products });
    expect(c.conversation.pendingItemChoice).toBeDefined();
    const result = c.send('deal 2 and 3', {
      products,
      actions: [
        { type: 'add_item', productId: 'deal-2', quantity: 1, modifierIds: [] },
        { type: 'add_item', productId: 'deal-3', quantity: 1, modifierIds: [] },
      ],
      response: { text: 'Anything else?', askFor: 'anything_else' },
    });
    expect(result.traces).not.toContain('item_choice_resolved');
    expect(lines(c)).toEqual(['deal-2 ×1', 'deal-3 ×1']);
  });

  it('reads numbered dishes as before on a menu without deals', () => {
    // What main (c5704f5) gives for the same messages.
    const platter = (k: number, category = 'Platters') =>
      dish(`platter-${k}`, `Platter ${k}`, { category, emoji: '🍱', price: 50000 });
    const legacy = (k: number) =>
      dish(`deal-${k}`, `Deal ${k}`, { category: 'Deals', emoji: '🍱', price: 50000 });
    const menu = [platter(1), platter(2), platter(3), legacy(1), legacy(2)];
    const turn = (text: string) => chat().send(text, { products: menu });
    expect(parse('platter 1 aur 2', menu)).toEqual(['add platter-1 ×2']);
    expect(turn('platter 1 aur 2').reply).toBe(
      'Added 2 × Platter 1. Add anything else, or send “review”.',
    );
    expect(parse('deal 1 and 2', menu)).toEqual(['which deal-1 | deal-2 ×2']);
    expect(turn('deal 1 and 2').reply).toBe('Which one would you like?\n1. Deal 1\n2. Deal 2');
    expect(parse('deal 1 aur 2 chahiye', menu)).toEqual(['add deal-1 ×2']);
    expect(parse('platter 2, make it 3', menu)).toEqual(['add platter-2 ×3']);
  });

  it('counts dishes named "Deal N" beside other dishes as before on a menu without deals', () => {
    // What main (c5704f5) gives for the same messages: a number in a dish's name is no name.
    const plain = (id: string, name: string) =>
      dish(id, name, { category: 'Deals', emoji: '🍱', price: 50000 });
    const menu = [
      plain('student', 'Student Deal'),
      plain('midnight', 'Midnight Deal'),
      plain('mighty', 'Mighty Meal'),
      plain('plain-1', 'Deal 1'),
      plain('plain-2', 'Deal 2'),
      plain('plain-3', 'Deal 3'),
    ];
    expect(parse('midnight deal aur 3 deal 1', menu)).toEqual([
      'add midnight ×1',
      'add plain-1 ×3',
    ]);
    expect(parse('midnight deal, 2 deal 2', menu)).toEqual(['add midnight ×1', 'add plain-2 ×2']);
    expect(parse('mighty meal and 3 deal 3', menu)).toEqual(['add mighty ×1', 'add plain-3 ×3']);
    expect(parse('student deal 2 please', menu)).toEqual(['add student ×2', 'add plain-2 ×1']);
    expect(parse('deal 1 or deal 2 3', menu)).toEqual(['add plain-1 ×1', 'add plain-2 ×3']);
    expect(parse('deal 2 2 please', menu)).toEqual([
      'which student | midnight | plain-1 | plain-2 | plain-3 ×2',
    ]);
    // The AI's 2 × Deal 2 asked about, then picked by its place in the list.
    const c = chat();
    const twice: BotAction = {
      type: 'add_item',
      productId: 'plain-2',
      quantity: 2,
      modifierIds: [],
    };
    const ok: ModelResponse = { text: '', askFor: 'none' };
    c.send('deal 2 2 please', { products: menu, actions: [twice], response: ok });
    expect(c.conversation.pendingItemChoice?.quantity).toBe(2);
    c.send('4', { products: menu, actions: [twice], response: ok });
    expect(lines(c)).toEqual(['plain-2 ×2']);
  });
});

describe('numbered deals written in Urdu, as combos or meals, or with "no" or "number"', () => {
  const numbered = [1, 2, 3, 10].map((k) =>
    deal(`deal-${k}`, `Deal ${k}`, { position: k, choices: [] }),
  );
  const products = catalog('13:00', numbered);
  const ok: ModelResponse = { text: 'Anything else?', askFor: 'anything_else' };
  const add = (productId: string, quantity = 1): BotAction => ({
    type: 'add_item',
    productId,
    quantity,
    modifierIds: [],
  });
  // "ek deal chahiye": the engine lists the deals on, "1. Deal 1 … 4. Deal 10".
  const listed = (menu = products) => {
    const c = chat();
    c.send('ek deal chahiye', { products: menu });
    expect(c.conversation.pendingItemChoice).toBeDefined();
    return c;
  };
  const send = (c: ReturnType<typeof chat>, text: string, actions: BotAction[], menu = products) =>
    c.send(text, { products: menu, actions, response: ok });

  it.each([
    ['ڈیل 2 اور 3', ['add deal-2 ×1', 'add deal-3 ×1']],
    ['ڈیل ۲ اور ۳', ['add deal-2 ×1', 'add deal-3 ×1']],
    ['ڈیل 2، 3', ['add deal-2 ×1', 'add deal-3 ×1']],
    ['ڈیل 2 اور 10', ['add deal-2 ×1', 'add deal-10 ×1']],
    ['2 ڈیل 1', ['add deal-1 ×2']],
    ['deal no 2 chahiye', ['add deal-2 ×1']],
    ['deal no. 2 chahiye', ['add deal-2 ×1']],
    ['deal number 10 bhej dein', ['add deal-10 ×1']],
    ['ڈیل نمبر 2 چاہیے', ['add deal-2 ×1']],
    ['number 3 deal bhej dein', ['add deal-3 ×1']],
    ['2 number deal chahiye', ['add deal-2 ×1']],
    ['deal no 2 aur 3', ['add deal-2 ×1', 'add deal-3 ×1']],
    // A number named with "deal" or "no" is no count, even with no such deal.
    ['deal no 7 chahiye', ['which deal-1 | deal-2 | deal-3 | deal-10 ×1']],
    ['deal 7 chahiye', ['which deal-1 | deal-2 | deal-3 | deal-10 ×1']],
    ['2 deal chahiye', ['which deal-1 | deal-2 | deal-3 | deal-10 ×2']],
  ])('reads “%s” by the deal’s number', (text, parsed) => {
    expect(parse(text, products)).toEqual(parsed);
  });

  it('reads "combos 2 and 10" and "meals 1 and 3" as one of each', () => {
    const combos = catalog(
      '13:00',
      [1, 2, 3, 10].map((k) => deal(`combo-${k}`, `Combo ${k}`, { position: k, choices: [] })),
    );
    expect(parse('combos 2 and 10', combos)).toEqual(['add combo-2 ×1', 'add combo-10 ×1']);
    expect(parse('combos 2, 3', combos)).toEqual(['add combo-2 ×1', 'add combo-3 ×1']);
    const meals = catalog(
      '13:00',
      [1, 2, 3].map((k) => deal(`meal-${k}`, `Meal ${k}`, { position: k, choices: [] })),
    );
    expect(parse('meals 1 and 3', meals)).toEqual(['add meal-1 ×1', 'add meal-3 ×1']);
    // Answering "which combo?" with two, the AI's one of each stands.
    const c = listed(combos);
    send(c, 'combos 2 and 10', [add('combo-2'), add('combo-10')], combos);
    expect(lines(c)).toEqual(['combo-2 ×1', 'combo-10 ×1']);
  });

  it('keeps the AI’s add of a deal named by its number, and refuses one not on', () => {
    for (const text of ['deal number 2 chahiye', 'deal no 2 de dein', 'ڈیل نمبر 2 چاہیے']) {
      const c = chat();
      const result = send(c, text, [add('deal-2')]);
      expect(result.traces).toEqual(['add_item']);
      expect(lines(c)).toEqual(['deal-2 ×1']);
    }
    // Only Deal 1 is on: Deal 2 is refused, never 2 × Deal 1.
    const dinner = catalog('13:00', [
      deal('deal-1', 'Deal 1', { choices: [] }),
      deal('deal-2', 'Deal 2', {
        position: 2,
        choices: [],
        schedule: { days: [0, 1, 2, 3, 4, 5, 6], start: '19:00', end: '23:00' },
      }),
    ]);
    for (const text of ['deal number 2 chahiye', 'deal no 2 de dein', 'ڈیل نمبر 2 چاہیے']) {
      const c = chat();
      expect(c.send(text, { products: dinner }).reply).toMatch(/^Deal 2 /);
      expect(lines(c)).toEqual([]);
    }
  });

  it('reads two deals named after "which deal?" as both, keeping the AI’s count', () => {
    const c = listed();
    const read = (text: string) => show(parseActions(company, products, c.conversation, text));
    expect(read('deal 2 aur 3')).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
    expect(read('ڈیل 2 اور 3')).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
    expect(read('deal 2 3 de dein')).toEqual(['add deal-2 ×1', 'add deal-3 ×1']);
    for (const [text, actions, cart] of [
      ['ڈیل 2 اور 10', [add('deal-2'), add('deal-10')], ['deal-2 ×1', 'deal-10 ×1']],
      ['deal 2 3 de dein', [add('deal-2', 3)], ['deal-2 ×3']],
      ['deal 2 3 de dein', [add('deal-2'), add('deal-3')], ['deal-2 ×1', 'deal-3 ×1']],
      ['deal 1 2 chahiye', [add('deal-1', 2)], ['deal-1 ×2']],
    ] as [string, BotAction[], string[]][]) {
      const answer = listed();
      send(answer, text, actions);
      expect(lines(answer)).toEqual(cart);
      expect(answer.conversation.pendingItemChoice).toBeUndefined();
    }
  });

  it('takes a number past the "which deal?" list as the number on a listed deal', () => {
    const local = listed();
    local.send('10', { products });
    expect(lines(local)).toEqual(['deal-10 ×1']);
    const ai = listed();
    const result = send(ai, '10', [add('deal-10')]);
    expect(result.traces).not.toContain('ambiguous_addition_prevented');
    expect(lines(ai)).toEqual(['deal-10 ×1']);
    // A place in the list is still that place; a number that is neither is asked again.
    const place = listed();
    place.send('4', { products });
    expect(lines(place)).toEqual(['deal-10 ×1']);
    const neither = listed();
    expect(neither.send('7', { products }).reply).toBe(
      'Aap kaun sa lena chahenge?\n1. Deal 1 — Rs. 799\n2. Deal 2 — Rs. 799\n3. Deal 3 — Rs. 799\n4. Deal 10 — Rs. 799',
    );
    expect(lines(neither)).toEqual([]);
  });

  it('keeps the AI’s count for a deal, whatever is written beside it', () => {
    // The engine never counts a deal the AI added again from the text.
    for (const [text, quantity, cart] of [
      ['deal 2 5 de dein', 1, 'deal-2 ×1'],
      ['deal 2 5 de dein', 5, 'deal-2 ×5'],
      ['deal 2 x3', 1, 'deal-2 ×1'],
      ['deal 2 x3', 3, 'deal-2 ×3'],
      ['3 deal 2', 1, 'deal-2 ×1'],
    ] as const) {
      const c = listed();
      send(c, text, [add('deal-2', quantity)]);
      expect(lines(c)).toEqual([cart]);
    }
  });
});

describe('a dish named inside a longer name, with a count beside the longer one', () => {
  const ok: ModelResponse = { text: '', askFor: 'none' };

  it('gives the shorter-named dish its own count, as main did', () => {
    // What main (c5704f5) gives for the same messages on menus without deals.
    expect(parse('burger single, 2 chicken burger', seed)).toEqual([
      `add ${smash.id} ×1`,
      `add ${crispy.id} ×2`,
    ]);
    for (const text of ['burger\n2 chicken burger', 'burger aur 2 chicken burger'])
      expect(parse(text, seed)).toEqual([`add ${smash.id} ×1`, `add ${crispy.id} ×2`]);
    const breads = [
      dish('naan', 'Naan', { category: 'Breads' }),
      dish('garlic-naan', 'Garlic Naan', { category: 'Breads' }),
    ];
    expect(parse('naan aur 4 garlic naan', breads)).toEqual(['add naan ×1', 'add garlic-naan ×4']);
    expect(parse('2 garlic naan aur 3 naan', breads)).toEqual([
      'add garlic-naan ×2',
      'add naan ×3',
    ]);
    const meals = [zinger, dish('zinger-meal', 'Zinger Meal', { category: 'Meals' })];
    for (const text of ['zinger, 2 zinger meal', 'bhai zinger burger ,Zinger Meal x2'])
      expect(parse(text, meals)).toEqual(['add zinger-burger ×1', 'add zinger-meal ×2']);
    const halves = [
      { id: 'half', name: 'Half', price: 0 },
      { id: 'full', name: 'Full', price: 0 },
    ];
    const karahi = [
      dish('chicken-karahi', 'Chicken Karahi', { aliases: ['karahi'], variants: halves }),
      dish('mutton-karahi', 'Mutton Karahi', { variants: halves }),
    ];
    expect(parse('chicken karahi half, 2 mutton karahi full', karahi)).toEqual([
      'add chicken-karahi ×1',
      'add mutton-karahi ×2',
    ]);
    // The whole order, as reviewed.
    const c = chat();
    c.send('burger single, 2 chicken burger', { products: seed });
    expect(lines(c)).toEqual([`${smash.id} ×1`, `${crispy.id} ×2`]);
  });

  it('keeps a deal named after a dish from giving the dish its count', () => {
    expect(parse('zinger, 2 zinger deal')).toEqual(['add zinger-burger ×1', 'add zinger-deal ×2']);
    expect(parse('fries aur 2 deal 1')).toEqual([`add ${fries.id} ×1`, 'add deal-1 ×2']);
  });

  it('asks "which burger?" for the count written by it, with the AI', () => {
    const menu = [
      dish('chicken-burger', 'Chicken Burger', { category: 'Burgers', aliases: ['burger'] }),
      dish('beef-burger', 'Beef Burger', { category: 'Burgers', aliases: ['burger'] }),
      zinger,
    ];
    const c = chat();
    c.send('burger, 2 zinger burger', {
      products: menu,
      actions: [
        {
          type: 'clarify_item',
          candidateProductIds: ['chicken-burger', 'beef-burger'],
          quantity: 1,
        },
        { type: 'add_item', productId: 'zinger-burger', quantity: 2, modifierIds: [] },
      ],
      response: ok,
    });
    expect(c.conversation.pendingItemChoice?.quantity).toBe(1);
    c.send('chicken', {
      products: menu,
      actions: [{ type: 'add_item', productId: 'chicken-burger', quantity: 1, modifierIds: [] }],
      response: ok,
    });
    expect(lines(c)).toEqual(['zinger-burger ×2', 'chicken-burger ×1']);
  });
});

describe('a saving the owner wrote, and AI wording that only starts the same way', () => {
  const feast = deal('feast', 'Family Feast', {
    choices: [],
    description: 'Two burgers, save 20% on weekends.',
  });
  const products = catalog('13:00', [feast]);
  const answer = (text: string, who: Company = company) =>
    chat(who).send('tell me about the family feast', {
      products,
      actions: [{ type: 'answer', text: '' }],
      response: { text, askFor: 'none', groundingIds: [] },
    });

  it('drops another amount and keeps the owner’s own phrase', () => {
    for (const text of ['Save 25% today on everything!', 'Save 2 on every burger today!']) {
      const result = answer(text);
      expect(result.reply).not.toContain(text);
      expect(result.traces).toContain('unsafe_model_response_ignored');
    }
    expect(answer('Save 20% on weekends with the Family Feast!').reply).toBe(
      'Save 20% on weekends with the Family Feast!',
    );
    // "save 200" in an approved answer, and "save 20%" in the deal's, vouch for neither "save
    // 2000" nor "save 20".
    const owner: Company = {
      ...company,
      faqs: [{ question: 'Any discount?', answer: 'Order the feast and save 200.' }],
    };
    for (const text of ['You save 2000 on big orders.', 'You save 20 on big orders.'])
      expect(answer(text, owner).traces).toContain('unsafe_model_response_ignored');
    expect(answer('Order the feast and save 200.', owner).reply).toBe(
      'Order the feast and save 200.',
    );
  });
});

describe('the chat menu for one numbered deal, and for deals at other times', () => {
  const ten = Array.from({ length: 10 }, (_, i) =>
    deal(`deal-${i + 1}`, `Deal ${i + 1}`, { position: i + 1, choices: [drink, side] }),
  );
  const products = catalog('13:00', ten);

  it('shows only the deal asked about by its number', () => {
    expect(parse('deal 9 kitne ki hai?', products)).toEqual(['menu Deal 9']);
    const nine = chat().send('deal 9 kitne ki hai?', { products }).reply;
    expect(nine).toContain(
      '🎁 Deal 9 — Rs. 799 (save Rs. 250)\n  Zinger burger + Fries + Drink\n  Drink: Coke, Sprite, Fanta (+Rs. 50)\n  Side: Fries, Wings (+Rs. 100)',
    );
    expect(nine).not.toContain('Deal 1 —');
    expect(nine).not.toContain('Showing');
    const one = chat().send('deal 1 hai?', { products }).reply;
    expect(one).toContain('🎁 Deal 1 — Rs. 799');
    for (const other of ['Deal 2 —', 'Deal 10 —']) expect(one).not.toContain(other);
    // The AI's search for it, and a shorthand question about all of them.
    const search = (query: string) =>
      chat().send('?', {
        products,
        actions: [{ type: 'menu', query }],
        response: { text: 'Here you go:', askFor: 'none' },
      }).reply;
    expect(search('deal 9')).not.toContain('Deal 1 —');
    expect(search('koi deal h')).toContain('🎁 Deal 2 — Rs. 799');
  });

  it('says the deals run at other times when none is on now, never "…and 2 more" alone', () => {
    const dinner = deal('dinner', 'Dinner Deal', { position: 6, schedule: weekdayLunch });
    const later = catalog('16:00', [lunchDeal, dinner]);
    const reply = chat().send('menu', { local: '16:00', products: later }).reply;
    expect(reply.split('\n').slice(0, 3)).toEqual([
      'Bun & Co.',
      'We have 2 deals at other times. Send “deals” to see them.',
      '🍔 Classic Smash — Rs. 690',
    ]);
    expect(chat().send('مینو', { local: '16:00', products: later }).reply).toContain(
      'دوسرے اوقات میں 2 ڈیلز دستیاب ہیں۔',
    );
  });

  it('keeps a deal with very long lists within one message, beside the dishes', () => {
    const long = (k: number) =>
      `Special family size item number ${k} with extra toppings and sauces`;
    const big = deal('big', 'Mega Party Deal', {
      items: Array.from({ length: 20 }, (_, k) => ({ name: long(k + 1), quantity: 2 })),
      choices: [
        {
          id: 'g-big',
          name: 'Flavour',
          options: Array.from({ length: 8 }, (_, k) => ({
            id: `o-${k}`,
            name: `${long(k + 1)} flavour`,
            price: 0,
          })),
        },
      ],
    });
    const many = catalog('13:00', [big, { ...big, id: 'big-2', name: 'Mega Party Deal 2' }]);
    const general = chat().send('menu', { products: many }).reply;
    expect(general.length).toBeLessThanOrEqual(4096);
    expect(general).toContain('🍔 Classic Smash — Rs. 690');
    const listed = chat().send('deals', { products: many }).reply;
    expect(listed).toContain('🎁 Mega Party Deal — Rs. 799');
    expect(listed).not.toContain('Showing 0');
  });
});

describe('deals sharing a name with another deal or a dish', () => {
  const ended = {
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '00:00',
    endDate: '2026-10-01',
  };
  const live = deal('new', 'Ramadan Deal', { position: 2, choices: [], price: 89900 });

  it('takes the deal on offer over a paused or ended one of the same name', () => {
    for (const old of [
      deal('old', 'Ramadan Deal', { position: 1, choices: [], schedule: ended }),
      deal('old', 'Ramadan Deal', { position: 1, choices: [], available: false }),
    ]) {
      const products = catalog('13:00', [old, live]);
      expect(parse('1 ramadan deal', products)).toEqual(['add new ×1']);
      expect(resolveItemMention(products, company.id, 'ramadan deal chahiye')).toMatchObject({
        kind: 'unique',
        product: { id: 'new' },
      });
      const c = chat();
      expect(c.send('Add 1 Ramadan Deal', { products }).reply).toBe(
        'Added 1 × Ramadan Deal. Add anything else, or send “review”.',
      );
      expect(lines(c)).toEqual(['new ×1']);
      // The AI unsure between them is asked as it proposed, the one not on marked.
      const ai = chat();
      const result = ai.send('1 ramadan deal', {
        products,
        actions: [{ type: 'clarify_item', candidateProductIds: ['old', 'new'], quantity: 1 }],
        response: { text: '', askFor: 'none' },
      });
      expect(result.reply).toBe(
        'Which one would you like?\n1. Ramadan Deal — Rs. 799 · Unavailable\n2. Ramadan Deal — Rs. 899',
      );
      expect(lines(ai)).toEqual([]);
    }
  });

  it('asks which one for two live deals of one name, or a live deal named like a dish', () => {
    const twin = deal('old', 'Ramadan Deal', { position: 1, choices: [] });
    const both = catalog('13:00', [twin, live]);
    expect(parse('1 ramadan deal', both)).toEqual(['which old | new ×1']);
    expect(chat().send('1 ramadan deal', { products: both }).reply).toBe(
      'Which one would you like?\n1. Ramadan Deal — Rs. 799\n2. Ramadan Deal — Rs. 899',
    );
    // Asked about, both are shown.
    const shown = chat().send('ramadan deal hai?', { products: both }).reply;
    expect(shown).toContain('🎁 Ramadan Deal — Rs. 799');
    expect(shown).toContain('🎁 Ramadan Deal — Rs. 899');
    const named = catalog('13:00', [deal('crispy-deal', 'Crispy Chicken', { choices: [] })]);
    expect(parse('1 crispy chicken', named)).toEqual([`which crispy-deal | ${crispy.id} ×1`]);
  });

  it('leaves the words to the dish when the deal of that name is paused or ended', () => {
    for (const over of [{ available: false }, { schedule: ended }])
      for (const gone of [
        deal('crispy-deal', 'Crispy Chicken', { choices: [], ...over }),
        deal('crispy-deal', 'Chicken Deal', { choices: [], aliases: ['Crispy Chicken'], ...over }),
      ]) {
        const products = catalog('13:00', [gone]);
        expect(parse('1 crispy chicken', products)).toEqual([`add ${crispy.id} ×1`]);
        const c = chat();
        c.send('1 crispy chicken', { products });
        expect(lines(c)).toEqual([`${crispy.id} ×1`]);
      }
  });
});

describe('a deal’s name inside a longer dish name', () => {
  const plain = dish('p-zinger', 'Zinger Burger', { category: 'Burgers' });
  // Without the Classic Smash, whose "burger" main also reads in "zinger burger".
  const products = catalog(
    '13:00',
    [{ ...zingerDeal, aliases: ['zinger'] }],
    [...seed.filter((p) => p !== smash), plain],
  );

  it('leaves "zinger burger" the burger, and "zinger" the deal', () => {
    expect(parse('1 zinger burger', products)).toEqual(['add p-zinger ×1']);
    expect(parse('2 zinger burger chahiye', products)).toEqual(['add p-zinger ×2']);
    expect(parse('1 zinger', products)).toEqual(['add zinger-deal ×1']);
    expect(parse('1 zinger deal and 2 zinger burger', products)).toEqual([
      'add zinger-deal ×1',
      'add p-zinger ×2',
    ]);
    expect(resolveItemMention(products, company.id, '1 zinger burger')).toMatchObject({
      kind: 'unique',
      product: { id: 'p-zinger' },
    });
    // What Test your bot's Add button sends for the burger.
    const c = chat();
    expect(c.send('Add 1 Zinger Burger', { products }).reply).toBe(
      'Added 1 × Zinger Burger. Add anything else, or send “review”.',
    );
    expect(lines(c)).toEqual(['p-zinger ×1']);
  });

  it('reads a deal word inside a dish’s name as that dish: "kids meal"', () => {
    const kidsMeal = dish('kids-meal', 'Kids Meal', { category: 'Meals' });
    const kids = catalog(
      '13:00',
      [deal('kids-deal', 'Kids Deal', { choices: [] })],
      [...seed, kidsMeal],
    );
    expect(parse('1 kids meal', kids)).toEqual(['add kids-meal ×1']);
    expect(parse('1 kids deal', kids)).toEqual(['add kids-deal ×1']);
  });
});

describe('the review’s deal lines and the whole message’s 1024 characters', () => {
  it('leaves them out when a line before the review would push the message past 1024', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      name: `Item number ${i + 1} of the family feast box!!!!!!`,
      quantity: 1,
    }));
    const feasts = Array.from({ length: 4 }, (_, i) =>
      deal(`feast-${i + 1}`, `Family Feast ${i + 1}`, { position: i + 1, choices: [], items }),
    );
    const products = catalog('13:00', feasts);
    const c = chat();
    for (const feast of feasts)
      c.send(feast.name, {
        products,
        actions: [{ type: 'add_item', productId: feast.id, quantity: 1, modifierIds: [] }],
      });
    const shown = c.send('pickup, Ali', {
      products,
      actions: [{ type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' }],
    });
    // The review alone fits with what the deals include.
    expect(shown.reply).toContain('Item number 1');
    expect(shown.reply.length).toBeGreaterThan(960);
    expect(shown.reply.length).toBeLessThanOrEqual(1024);
    c.send('cart?', { products, actions: [{ type: 'cart_summary' }] });
    const again = c.send('confirm', { products, actions: [{ type: 'confirm' }] });
    expect(again.traces).toEqual(['confirm', 'fresh_confirmation_required']);
    expect(again.reply.startsWith('Please confirm the current details below.\n\n')).toBe(true);
    expect(again.reply).not.toContain('Item number');
    expect(again.reply.length).toBeLessThanOrEqual(1024);
    expect(c.conversation.cart.reviewMessageId).toBeDefined();
    expect(c.send('confirm', { products }).order).toBeDefined();
  });
});
