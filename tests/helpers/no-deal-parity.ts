/**
 * Restaurants without deals: this branch's engine side by side with main's (c5704f5, vendored
 * byte for byte in tests/fixtures/main-c5704f5 with what it imports). A message is read by both
 * from the same conversation: parseActions, a local-rules turn, and two AI-path turns (the AI
 * proposing main's own reading, and a plain one adding every dish named once).
 */
import * as head from '../../src/domain/engine';
import { DEAL_WORDS, editDistance, normalizeCatalogText } from '../../src/domain/menu-resolver';
import { sellableCatalog } from '../../src/shared/deals';
import { seedCompanies, seedProducts } from '../../src/shared/seed';
import type {
  BotAction,
  Company,
  Conversation,
  Deal,
  DealChoiceGroup,
  ModelResponse,
  Product,
  TurnInput,
  TurnResult,
} from '../../src/shared/types';
import * as main from '../fixtures/main-c5704f5/domain/engine';

interface Engine {
  createConversation(
    companyId: string,
    phone: string,
    channel: Conversation['channel'],
    now: string,
  ): Conversation;
  parseActions(
    company: Company,
    products: Product[],
    conversation: Conversation,
    text: string,
  ): BotAction[];
  processTurn(
    company: Company,
    products: Product[],
    conversation: Conversation,
    input: TurnInput,
    actions?: BotAction[],
    modelResponse?: ModelResponse,
  ): TurnResult;
}
export const MAIN = main as unknown as Engine;
export const HEAD = head as unknown as Engine;

// Tuesday 20 October 2026, 13:00 in Karachi; every menu here is open all day.
export const NOW = '2026-10-20T08:00:00.000Z';

const [dastarkhwan, bun] = seedCompanies as [Company, Company];
const own = (company: Company) => seedProducts.filter((p) => p.companyId === company.id);
function shop(id: string, name: string): Company {
  return { ...bun, id, name, slug: id, faqs: [] };
}
function dishes(company: Company, list: [string, string, Partial<Product>?][]): Product[] {
  return list.map(([name, category, extra = {}], k) => ({
    id: `${company.id}-p${k + 1}`,
    companyId: company.id,
    name,
    description: '',
    category,
    price: 30000 + k * 5000,
    available: true,
    emoji: '🍽️',
    aliases: [],
    variants: [],
    modifiers: [],
    ...extra,
  }));
}
const sizes = (company: string, dish: string, names: string[]) =>
  names.map((name, k) => ({ id: `${company}-${dish}-${k + 1}`, name, price: 40000 + k * 30000 }));

// Two Pakistani menus without deals, with the names deals are often confused with.
const lahori = shop('lahori-grill', 'Lahori Grill');
const karachi = shop('karachi-broast', 'Karachi Broast');
const lahoriMenu = dishes(lahori, [
  ['Zinger Burger', 'Burgers', { aliases: ['zinger', 'zinger burger', 'زنگر برگر'] }],
  ['Chicken Burger', 'Burgers', { aliases: ['chicken burger', 'burger'] }],
  ['Beef Burger', 'Burgers', { aliases: ['beef burger'] }],
  ['Kids Meal', 'Meals', { aliases: ['kids meal'] }],
  ['Zinger Meal', 'Meals'],
  ['Family Combo', 'Meals', { aliases: ['family combo', 'combo'] }],
  [
    'Chicken Karahi',
    'Karahi',
    {
      aliases: ['karahi', 'chicken karahi', 'کڑاہی'],
      variants: sizes('lahori', 'ck', ['Half', 'Full']),
      modifiers: [{ id: 'lahori-butter', name: 'Extra butter', price: 10000 }],
    },
  ],
  [
    'Mutton Karahi',
    'Karahi',
    { aliases: ['mutton karahi'], variants: sizes('lahori', 'mk', ['Half', 'Full']) },
  ],
  ['Sprite 345ml', 'Drinks', { aliases: ['sprite'] }],
  ['Sprite 1.5L', 'Drinks', { aliases: ['sprite', 'sprite 1.5 litre', 'badi sprite'] }],
  ['Deal 1', 'Deals'],
  ['Deal 2', 'Deals'],
  ['Deal 3', 'Deals'],
  ['Daal Chawal', 'Rice', { aliases: ['daal', 'dal chawal', 'دال چاول'] }],
  ['Fries', 'Sides', { aliases: ['fries', 'فرائز'] }],
  ['Loaded Fries', 'Sides'],
  ['Butter Naan', 'Breads', { aliases: ['naan', 'نان'] }],
  ['Garlic Naan', 'Breads'],
  ['Raita', 'Sides'],
]);
const karachiMenu = dishes(karachi, [
  [
    'Chicken Broast',
    'Broast',
    {
      aliases: ['broast', 'بروسٹ'],
      variants: sizes('karachi', 'cb', ['Quarter', 'Half', 'Full']),
      modifiers: [
        { id: 'karachi-garlic', name: 'Garlic sauce', price: 5000 },
        { id: 'karachi-fries', name: 'Extra fries', price: 9000 },
      ],
    },
  ],
  ['Broast Meal', 'Meals'],
  ['Student Combo', 'Meals', { aliases: ['student deal'] }],
  ['Midnight Offer', 'Meals'],
  ['Kids Meal', 'Meals'],
  ['Zinger Burger', 'Burgers', { aliases: ['zinger'] }],
  ['Pepsi 345ml', 'Drinks', { aliases: ['pepsi'] }],
  ['Pepsi 1.5L', 'Drinks', { aliases: ['pepsi', 'pepsi 1.5', 'بڑی پیپسی'] }],
  ['7up 345ml', 'Drinks', { aliases: ['7up'] }],
  ['Mineral Water', 'Drinks', { aliases: ['water', 'pani'] }],
  ['Seekh Kabab', 'BBQ', { aliases: ['kabab', 'seekh kabab', 'سیخ کباب'] }],
  ['Chicken Tikka', 'BBQ', { aliases: ['tikka'] }],
  ['Malai Boti', 'BBQ'],
  [
    'Mutton Karahi',
    'Karahi',
    { aliases: ['karahi', 'کڑاہی'], variants: sizes('karachi', 'mk', ['Half', 'Full']) },
  ],
  ['Deal 1', 'Deals', { aliases: ['deal no 1'] }],
  ['Deal 2', 'Deals'],
  ['Deal 3', 'Deals'],
  ['Daal Mash', 'Curries', { aliases: ['daal', 'dal'] }],
  ['Platter 1', 'BBQ'],
  ['Platter 2', 'BBQ'],
]);

export interface Menu {
  name: string;
  company: Company;
  products: Product[];
  // A word several dishes share, for a "which one?" to be open.
  family: string;
  // A dish to put in the cart before a review.
  order: string;
}
export const menus: Menu[] = [
  {
    name: 'Dastarkhwan',
    company: dastarkhwan,
    products: own(dastarkhwan),
    family: 'chicken',
    order: '2 biryani',
  },
  { name: 'Bun & Co.', company: bun, products: own(bun), family: 'burger', order: '2 fries' },
  {
    name: 'Lahori Grill',
    company: lahori,
    products: lahoriMenu,
    family: 'burger',
    order: '2 zinger burger',
  },
  {
    name: 'Karachi Broast',
    company: karachi,
    products: karachiMenu,
    family: 'pepsi',
    order: '2 tikka',
  },
];

// The same menus with deals (A2): a message naming no deal reads its dishes as main reads them
// on the dishes alone.
const drinks: DealChoiceGroup = {
  id: 'g-drink',
  name: 'Drink',
  options: [
    { id: 'o-pepsi', name: 'Pepsi', price: 0 },
    { id: 'o-7up', name: '7up', price: 0 },
    { id: 'o-sprite', name: 'Sprite', price: 2000 },
  ],
};
function deals(company: Company, names: string[]): Deal[] {
  return names.map((name, k) => ({
    id: `${company.id}-deal-${k + 1}`,
    companyId: company.id,
    name,
    description: '',
    emoji: '🎁',
    aliases: [],
    price: 99900,
    items: [{ name: 'Zinger burger', quantity: 1 }],
    choices: k % 2 ? [] : [drinks],
    available: true,
    // The last one runs at night only: on the bot's list, refused by name now.
    schedule:
      k === names.length - 1
        ? { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '03:00' }
        : undefined,
    position: k + 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
  }));
}
const dealNames: Record<string, string[]> = {
  Dastarkhwan: ['Biryani Deal', 'Karahi Deal 1', 'Karahi Deal 2', 'Midnight Deal'],
  'Bun & Co.': ['Zinger Deal', 'Smash Deal 1', 'Smash Deal 2', 'Midnight Deal'],
  'Lahori Grill': ['Zinger Deal', 'Family Deal 1', 'Family Deal 2', 'Midnight Deal'],
  'Karachi Broast': ['Broast Deal', 'Student Deal 1', 'Student Deal 2', 'Midnight Deal'],
};
/** The menu as the bot sells it with deals: every deal, the night one refusable by name. */
export const withDeals = (menu: Menu): Product[] =>
  sellableCatalog(menu.company, menu.products, deals(menu.company, dealNames[menu.name]!), NOW, {
    all: true,
  });
/**
 * Whether a message names no deal of `withDeals(menu)`: no deal's name, and no deal word but
 * inside a dish's own name ("Kids Meal").
 */
export function namesNoDeal(menu: Menu, text: string): boolean {
  let rest = ` ${normalizeCatalogText(text)} `;
  if (dealNames[menu.name]!.some((name) => rest.includes(` ${normalizeCatalogText(name)} `)))
    return false;
  for (const label of menu.products
    .flatMap((p) => [p.name, ...p.aliases])
    .map(normalizeCatalogText)
    .sort((a, b) => b.length - a.length))
    if (label) rest = rest.split(` ${label} `).join('  ');
  return !words(rest).some((word) => DEAL_WORDS.has(word));
}

// The conversations a message is read in: a fresh chat, one asked "which one?", and one whose
// review waits for "confirm". Built once with main's engine, so both engines start alike.
export type State = 'fresh' | 'asked' | 'review';
export function states(menu: Menu): Record<State, Conversation> {
  const fresh = MAIN.createConversation(menu.company.id, '923001234567', 'whatsapp', NOW);
  const send = (conversation: Conversation, text: string, n: number) =>
    MAIN.processTurn(menu.company, menu.products, conversation, {
      messageId: `setup-${n}`,
      text,
      now: NOW,
    }).conversation;
  const asked = send(fresh, menu.family, 1);
  if (!asked.pendingItemChoice) throw new Error(`${menu.name}: "${menu.family}" asks nothing`);
  const review = send(send(fresh, menu.order, 2), 'pickup, my name is Ali', 3);
  if (review.cart.status !== 'awaiting_confirmation')
    throw new Error(`${menu.name}: no review is waiting`);
  return { fresh, asked, review };
}

const contains = (text: string, phrase: string) => {
  const p = normalizeCatalogText(phrase);
  return !!p && ` ${normalizeCatalogText(text)} `.includes(` ${p} `);
};
// A plain AI: every dish named once, one of each.
export const plainAi = (menu: Menu, text: string): BotAction[] => {
  const named = menu.products.filter((p) =>
    [p.name, ...p.aliases].some((label) => contains(text, label)),
  );
  return named.length
    ? named.map((p) => ({ type: 'add_item', productId: p.id, quantity: 1, modifierIds: [] }))
    : [{ type: 'answer', text: '' }];
};
const response: ModelResponse = { text: 'Sure! Anything else?', askFor: 'anything_else' };

/** What one engine makes of a message in each way it can be read, as JSON. */
function readings(
  engine: Engine,
  menu: Menu,
  conversation: Conversation,
  text: string,
  parsed: BotAction[],
  proposals: BotAction[][],
) {
  const { company, products } = menu;
  const input: TurnInput = { messageId: 'parity-1', text, now: NOW };
  const turn = (actions?: BotAction[], model?: ModelResponse) => {
    try {
      return JSON.stringify(
        engine.processTurn(company, products, conversation, input, actions, model),
      );
    } catch (error) {
      return `threw ${(error as Error).message}`;
    }
  };
  return {
    parse: JSON.stringify(parsed),
    local: turn(),
    ai: turn(proposals[0], response),
    plainAi: turn(proposals[1], response),
  };
}
export type Readings = ReturnType<typeof readings>;
/** Both engines' readings of a message, the AI proposing the same actions to each. */
export function readBoth(menu: Menu, conversation: Conversation, text: string) {
  const { company, products } = menu;
  const mainParse = MAIN.parseActions(company, products, conversation, text);
  const headParse = HEAD.parseActions(company, products, conversation, text);
  // The AI reads it as main did, or adds every dish named once.
  const proposals = [mainParse, plainAi(menu, text)];
  return {
    main: readings(MAIN, menu, conversation, text, mainParse, proposals),
    head: readings(HEAD, menu, conversation, text, headParse, proposals),
  };
}

/**
 * The fixed corpus: English, Roman Urdu and Urdu; orders, counts, options, questions, cancels,
 * details, mixed parts and one item per line, with the names deals are confused with.
 */
const written = [
  // Orders, English.
  '2 chicken biryani',
  'one chicken biryani please',
  'I want 3 naan',
  'can I get a zinger burger',
  '2 zinger burgers and 1 fries',
  'add 2 butter naan',
  'give me two mango lassi',
  'I’ll have the chicken karahi half',
  'chicken karahi full with extra butter',
  '1 classic smash double with extra cheese',
  'classic smash single',
  '3 loaded fries',
  'a brownie please',
  '2 seekh kebab',
  '4 garlic naan and 2 raita',
  '1 beef burger, 1 chicken burger',
  'two crispy chicken',
  '1 kids meal',
  '2 kids meals',
  'family combo',
  '1 family combo please',
  'zinger meal x2',
  '2x zinger meal',
  'broast quarter',
  '1 chicken broast half with garlic sauce',
  'full broast',
  '2 pepsi',
  'one pepsi 1.5',
  '7up',
  '2 sprite 345ml',
  'sprite 1.5L',
  'badi sprite',
  'water',
  '2 mineral water',
  'malai boti',
  'platter 1',
  '2 platter 2',
  'platter 1 and 2',
  'deal 1',
  'deal 2 please',
  '2 deal 3',
  'deal no 1',
  'deal 1 and deal 2',
  'deal 2 and 3',
  'deal 1 x2',
  'daal chawal',
  'daal',
  '2 dal',
  'mutton karahi half',
  'mutton karahi',
  'karahi',
  'chicken',
  'burger',
  'lassi',
  'naan',
  'tikka',
  'kebab',
  'kabab 3',
  '100 naan',
  '60 biryani',
  // Orders, Roman Urdu.
  '2 biryani chahiye',
  'mujhe 3 naan chahiye',
  'ek chicken karahi half de do',
  'do zinger burger bhej do',
  'teen naan aur ek daal',
  'biryani 2 de dein',
  'naan 4 chahiye',
  'chicken wali 2',
  'tikka 2 aur naan 3',
  'ek karahi full aur 4 naan',
  'karahi half 4 naan',
  'naan 3 chicken biryani',
  '3 naan 2 chicken biryani',
  'biryani bhej do DHA phase 5',
  'biryani 8 baje tak bhej dein',
  'house 12 street 4 biryani',
  'aik zinger aur aik fries',
  'do pepsi aur ek broast',
  'broast half garlic sauce ke sath',
  'zinger burger extra cheese ke sath',
  '2 kids meal de dein',
  'combo chahiye',
  'family combo dena',
  'deal 1 chahiye',
  'deal 2 de do',
  'do deal 3',
  'deal 1 aur deal 2 chahiye',
  'ek seekh kabab aur do naan',
  'daal chahiye',
  'daal makhani 2',
  'gulab jamun 4',
  'lassi do',
  'mango lassi teen',
  'brownie aik',
  'sprite badi wali',
  'pepsi choti',
  'pani 2 bottle',
  'biryani de do na',
  'bhej do chicken wali',
  'kar do 2 naan',
  'biryani, make it 3',
  'naan, 3',
  'biryani x2',
  // Orders, Urdu.
  '2 بریانی',
  'ایک چکن کڑاہی',
  'دو نان',
  'تین نان اور ایک دال',
  'مجھے بریانی چاہیے',
  'دو زنگر برگر بھیج دیں',
  'سیخ کباب ۲',
  '۳ نان',
  'ایک بروسٹ',
  'بڑی پیپسی',
  'لسی',
  'کڑاہی ہاف',
  'چکن برگر',
  'فرائز',
  'دال چاول',
  'بریانی دو',
  'چکن تکہ اور نان',
  // Answers and options.
  'half',
  'full',
  'single',
  'double',
  'quarter',
  'extra cheese',
  'option 2',
  '1',
  '2',
  '3',
  '4',
  '13',
  '2.',
  'the first one',
  'first',
  'pehla',
  'dusra wala',
  'chicken biryani',
  'karahi wali',
  'crispy',
  'smash',
  'beef',
  'zinger',
  'chicken burger',
  '345ml',
  '1.5L',
  'big one',
  'choti',
  'with garlic sauce',
  'no cheese',
  'without jalapenos',
  '3 chicken karahi',
  'option 1 please',
  // Questions.
  'menu',
  'menu please',
  'show menu',
  'menu dikhao',
  'what do you have?',
  'biryani price?',
  'how much is the karahi',
  'karahi kitne ki hai',
  'kya naan available hai',
  'is the brownie available',
  'zinger burger hai?',
  'do you have broast',
  'what is in the zinger meal',
  'family combo mein kya hai',
  'kids meal mein kya aata hai',
  'tell me about deal 1',
  'deal 1 kitne ki hai',
  'price of sprite 1.5L',
  'timings?',
  'kab tak khule ho',
  'delivery hai?',
  'do you deliver to DHA',
  'do you offer delivery',
  'delivery offer karte hain?',
  'is there egg in the biryani',
  'kya biryani mein anda hai',
  'does the zinger have peanuts',
  'what is the best meal?',
  'any vegetarian options?',
  'payment kaise karein',
  'jazzcash chalega?',
  'where are you located',
  'کیا بریانی دستیاب ہے',
  'کڑاہی کتنے کی ہے',
  'مینو',
  'مینو دکھائیں',
  // Cancels, the review and details.
  'cancel',
  'cancel my order',
  'order cancel kar do',
  'new order',
  'start over',
  'naya order',
  'remove naan',
  'naan hatao',
  'remove 1 biryani',
  'biryani nahi chahiye',
  'don’t want fries',
  'dont want the naan',
  'no fries',
  'review',
  'checkout',
  'total kitna hua',
  'bas',
  'done',
  'confirm',
  'yes',
  'haan',
  'haan confirm kar do',
  'confirm kar dein',
  'ok',
  'thanks',
  'shukriya',
  'staff',
  'human se baat karni hai',
  'manager please',
  'insaan se baat karao',
  'عملہ',
  'pickup',
  'delivery',
  'delivery to Gulberg',
  'F-7 delivery',
  'mera naam Ali hai',
  'my name is Sara',
  'name: Usman',
  'address: house 12 street 4 DHA',
  'pata: flat 3 blue area',
  'Ali',
  'what did I order',
  'mera order dikhao',
  'repeat my order',
  'hi',
  'salam',
  'السلام علیکم',
  'hello',
  'میرا آرڈر بتائیں',
  'آرڈر کینسل کر دیں',
  // Mixed parts and one item per line.
  '2 biryani, 3 naan aur 1 lassi',
  'karahi half, 4 naan, 2 raita',
  '1 zinger burger, 2 fries aur ek sprite',
  '2 broast quarter and 2 pepsi',
  'biryani aur naan',
  'naan aur biryani',
  'tikka 2, kabab 3',
  '2 chicken burger aur 1 burger',
  '1 chicken burger',
  '1 chicken burger aur 1 burger',
  '1 chicken burger aur 2 burger',
  'burger single, 2 chicken burger',
  'burger\n2 chicken burger',
  'naan aur 4 garlic naan',
  '2 garlic naan aur 3 naan',
  'zinger, 2 zinger meal',
  'bhai zinger burger ,Zinger Meal x2',
  'chicken karahi half, 2 mutton karahi full',
  '2 biryani\n3 naan\n1 lassi',
  'zinger burger\nfries\nsprite',
  '1 kids meal\n2 zinger meal\n1 family combo',
  'deal 1\ndeal 2',
  '2 deal 1 aur 3 deal 2',
  'deal 1, 2 pepsi',
  'zinger burger 2 deal 1',
  'fries aur 2 deal 1',
  '2 biryani pickup, mera naam Ali hai',
  '3 naan delivery to DHA',
  '2 zinger burger, review',
  'add 2 naan and checkout',
  'remove fries and add 2 naan',
  '2 sprite aur 1 badi sprite',
  'pepsi aur 1.5 litre pepsi',
  'zinger burger aur zinger meal',
  'kids meal aur family combo',
  '2 platter 1 aur 1 platter 2',
  'chicken biryani 2\nbutter naan 4\nmango lassi 2',
  '1 بریانی\n2 نان',
  // Deal words, on menus without deals.
  'deal',
  'deals',
  'deals?',
  'koi deal hai?',
  'deal hai kya',
  'any deals?',
  'any offers?',
  'what deals do you have',
  'deals dikhao',
  'koi offer hai',
  'offers?',
  'combo?',
  'combos',
  'ڈیل',
  'ڈیلز',
  'کوئی ڈیل ہے؟',
  'deal chahiye',
  'ek deal dena',
  '2 biryani aur ek deal',
  '2 biryani, koi offer hai?',
  'deal price?',
  'lunch deal',
  'midnight deal dena',
  'student deal',
  'student deal chahiye',
  'midnight offer',
  'midnight offer hai?',
  'meal',
  'meals',
  'koi achi deal batao',
  'today’s deals',
  'deals kya hain',
  'aaj ki deal',
  'combo offer',
  'family deal',
  'daal deal',
  'deal daal',
  'deal 4',
  'deal 12',
  'deals 2',
  '2 deals',
  'offer 2',
  'combos 2',
];
// Counts, dishes and endings put together, in a fixed order.
const counts = ['', '1', '2', 'ek', 'do', 'teen', 'x2', '۲'];
const named = [
  'biryani',
  'karahi',
  'naan',
  'burger',
  'zinger',
  'pepsi',
  'sprite',
  'fries',
  'kids meal',
  'family combo',
  'deal 2',
  'daal',
  'broast',
  'tikka',
  'lassi',
  'بریانی',
  'نان',
];
const endings = ['', 'chahiye', 'please', 'de do', 'aur 2 naan'];
const built = counts.flatMap((count, c) =>
  named.flatMap((dish, d) =>
    endings
      .filter((_, e) => (c + d + e) % 3 === 0)
      .map((ending) =>
        (count === 'x2' ? `${dish} x2 ${ending}` : `${count} ${dish} ${ending}`).trim(),
      ),
  ),
);
export const CORPUS = [...new Set([...written, ...built])];
// The hand-written ones, read in every state of a chat (the rest in a fresh chat only).
export const WRITTEN = [...new Set(written)];

// The exceptions the deals work makes on every menu (DEALS-DESIGN amendment v3, A1):
// (b) a generic deal word never matches a dish by a typo ("deal" is not "daal");
// (d) a message only of deal words and fillers asks for the deals.
const ONLY_DEALS = new Set(['deal', 'deals', 'ڈیل', 'ڈیلز', 'ڈیلیں']);
export const B_WORDS = new Set([...ONLY_DEALS, 'combo', 'combos', 'offer', 'offers']);
const words = (text: string) => normalizeCatalogText(text).split(' ').filter(Boolean);
// Main's typo rule (menu-resolver resolveItemMention): one letter off, two from 8 letters.
const typo = (input: string, label: string) => {
  const limit = input.length >= 8 ? 2 : 1;
  return (
    input !== label &&
    input.length >= 4 &&
    label.length >= 4 &&
    Math.abs(input.length - label.length) <= limit &&
    editDistance(input, label) <= limit &&
    // "combos" is still read as the plural of a Family Combo's "combo"; "deals" never.
    (ONLY_DEALS.has(input) || input.replace(/s$/u, '') !== label.replace(/s$/u, ''))
  );
};
/** The dishes main could only have found by reading a deal word as a typo of their names. */
export function typoDishes(menu: Menu, text: string): Product[] {
  const said = words(text).filter((word) => B_WORDS.has(word));
  return menu.products.filter((p) =>
    [p.name, ...p.aliases].some((label) =>
      words(label).some((token) => said.some((word) => typo(word, token))),
    ),
  );
}
/**
 * Why HEAD may read this message apart from main: 'd' when HEAD shows the deals for it, 'b' when
 * main's reading holds a dish only a deal word's typo found and HEAD's parse does not, else
 * undefined (no exception).
 */
export function exception(menu: Menu, text: string, mainReading: Readings, headReading: Readings) {
  const headParse = JSON.parse(headReading.parse) as BotAction[];
  if (
    headParse.length === 1 &&
    headParse[0]!.type === 'menu' &&
    headParse[0]!.query === 'deals' &&
    words(text).some((word) => B_WORDS.has(word))
  )
    return 'd' as const;
  const found = (reading: string, p: Product) =>
    reading.includes(p.id) || reading.includes(`"query":"${p.name}"`);
  const typos = typoDishes(menu, text);
  const all = Object.values(mainReading).join('\n');
  if (typos.some((p) => found(all, p) && !found(headReading.parse, p))) return 'b' as const;
  return undefined;
}
