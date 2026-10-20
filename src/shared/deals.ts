import type { Company, Deal, DealSchedule, DealState, Language, Product } from './types';
import {
  beforeStartDate,
  dealEnded,
  dealOpenAt,
  isNightWindow,
  localClock,
  toMinute,
  type Clock,
} from './hours';

// Deals as the system sells them: their state at a moment, how their times read, and the menu
// entries they become. Only types, hours and the menu page's helpers are imported, so the
// server, the engine and the dashboard can load it without each other. The menu page itself
// needs only dealSavings, which lives in shared/menu.ts so this file stays out of its chunk;
// the Deals tab's own helpers are in shared/deal-insights.ts.
export { dealSavings } from './menu';

/** What one deal may hold. The server refuses more, and the Deals editor checks the same. */
export const DEAL_LIMITS = {
  name: 120,
  description: 500,
  emoji: 16,
  otherNames: 10,
  otherName: 60,
  items: 20,
  itemName: 100,
  quantity: 50,
  choices: 5,
  choiceName: 80,
  options: 25,
  optionName: 100,
  /** Any price or extra charge, in paisa (Rs 1,000,000). */
  price: 100_000_000,
} as const;

const say = (lang: Language, en: string, ur: string, roman: string) =>
  lang === 'ur' ? ur : lang === 'roman-ur' ? roman : en;
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const URDU_DAYS = ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const URDU_MONTHS = [
  'جنوری',
  'فروری',
  'مارچ',
  'اپریل',
  'مئی',
  'جون',
  'جولائی',
  'اگست',
  'ستمبر',
  'اکتوبر',
  'نومبر',
  'دسمبر',
];
const isDay = (day: number) => Number.isInteger(day) && day >= 0 && day <= 6;

/** paused → ended → later (not on at this time) → sold out → on. */
export function dealState(deal: Deal, products: Product[], clock: Clock | undefined): DealState {
  if (!deal.available) return 'paused';
  if (dealEnded(deal.schedule, clock)) return 'ended';
  if (!dealOpenAt(deal.schedule, clock)) return 'later';
  // Only items still on the menu count: Sheets can re-id items, and the Deals tab warns about
  // broken links. A size that no longer exists counts as unlinked, not sold out.
  const soldOut = deal.items.some((item) => {
    const product = item.productId
      ? products.find((p) => p.id === item.productId && p.companyId === deal.companyId)
      : undefined;
    if (!product || (item.variantId && !product.variants.some((v) => v.id === item.variantId)))
      return false;
    return !product.available;
  });
  return soldOut ? 'sold_out' : 'on';
}

/** Listed days as runs in week order from Monday: "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri". */
export function daysText(days: number[], lang: Language): string {
  const listed = new Set(days.filter(isDay));
  const names = lang === 'ur' ? URDU_DAYS : lang === 'roman-ur' ? DAYS : SHORT_DAYS;
  const runs: string[] = [];
  for (const first of [1, 2, 3, 4, 5, 6, 0]) {
    if (!listed.has(first) || listed.has((first + 6) % 7)) continue;
    let last = first;
    while (listed.has((last + 1) % 7) && (last + 1) % 7 !== first) last = (last + 1) % 7;
    runs.push(
      last === first
        ? names[first]!
        : `${names[first]}${lang === 'ur' ? ' تا ' : '–'}${names[last]}`,
    );
  }
  return runs.join(lang === 'ur' ? '، ' : ', ');
}

// "14 Aug", with the year only when it isn't the clock's year (or there is no clock).
function dateText(date: string, lang: Language, clock: Clock | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match && (lang === 'ur' ? URDU_MONTHS : MONTHS)[Number(match[2]) - 1];
  if (!match || !month) return date;
  const year = clock?.date.slice(0, 4) === match[1] ? '' : ` ${match[1]}`;
  return `${Number(match[3])} ${month}${year}`;
}

/**
 * When a deal is on, in words: 'Mon–Fri 12:00–15:00', 'Every day 23:00–02:00', 'Fri night
 * 00:00–03:00', 'All day Sat–Sun', then ' · from 2 Mar' while it hasn't started and
 * ' · until 14 Aug' when it has an end date. '' with no schedule. "Hasn't started" is
 * dealOpenAt's rule, so at 01:00 on 2 Mar a 23:00–02:00 deal from 2 Mar (still the night of
 * 1 Mar) keeps its "from 2 Mar" instead of reading as on at a time it is refused.
 */
export function dealWhen(
  schedule: DealSchedule | undefined,
  lang: Language,
  clock?: Clock,
): string {
  if (!schedule) return '';
  const night = isNightWindow(schedule);
  // A night window is named by its evening: stored day d is the night of day d - 1.
  const days = night ? schedule.days.map((day) => (day + 6) % 7) : schedule.days;
  const every = new Set(days.filter(isDay)).size === 7;
  const named = every ? '' : daysText(days, lang);
  const times = `${schedule.start}–${schedule.end}`;
  const parts = [
    toMinute(schedule.start) === toMinute(schedule.end)
      ? every
        ? say(lang, 'All day', 'سارا دن', 'poora din')
        : say(lang, `All day ${named}`, `${named} سارا دن`, `${named} poora din`)
      : night
        ? every
          ? say(lang, `Every night ${times}`, `ہر رات ${times}`, `har raat ${times}`)
          : say(
              lang,
              `${named} night ${times}`,
              `${named} کی رات ${times}`,
              `${named} raat ${times}`,
            )
        : every
          ? say(lang, `Every day ${times}`, `روزانہ ${times}`, `rozana ${times}`)
          : `${named} ${times}`,
  ];
  if (schedule.startDate && (!clock || beforeStartDate(schedule, clock))) {
    const date = dateText(schedule.startDate, lang, clock);
    parts.push(say(lang, `from ${date}`, `${date} سے`, `${date} se`));
  }
  if (schedule.endDate) {
    const date = dateText(schedule.endDate, lang, clock);
    parts.push(say(lang, `until ${date}`, `${date} تک`, `${date} tak`));
  }
  return parts.join(' · ');
}

/** "1 × Zinger burger" for each item, from the names stored on the deal. */
export const dealIncludes = (deal: Pick<Deal, 'items'>) =>
  deal.items.map((item) => `${item.quantity} × ${item.name}`);

/** The menu entry a deal becomes at one moment. Never saved: it is rebuilt for each sale. */
export function dealProduct(
  deal: Deal,
  state: DealState,
  clock: Clock | undefined,
  dealCategory: string,
): Product {
  const when = dealWhen(deal.schedule, 'en', clock);
  return {
    id: deal.id,
    companyId: deal.companyId,
    name: deal.name,
    description: deal.description,
    emoji: deal.emoji,
    ...(deal.imageUrl && { imageUrl: deal.imageUrl }),
    aliases: deal.aliases,
    category: dealCategory,
    price: deal.price,
    available: state === 'on',
    variants: [],
    modifiers: [],
    deal: {
      includes: dealIncludes(deal),
      choices: deal.choices,
      ...(deal.regularPrice !== undefined && { regularPrice: deal.regularPrice }),
      state,
      ...(when && { when }),
      ...(deal.schedule && { schedule: deal.schedule }),
    },
  };
}

let collator: Intl.Collator | undefined;
const byName = (a: string, b: string) =>
  (collator ??= new Intl.Collator('en', { numeric: true })).compare(a, b);

/**
 * Deals as menu entries at `nowIso`, ahead of the products. Paused and ended deals are left out
 * unless `all` (the bot, so it can refuse them by name) or their id is in `keepIds` (a cart
 * that holds them, so the refusal can name them). A deal sharing a product's id is left out:
 * the database prices that id as the product.
 */
export function sellableCatalog(
  company: Pick<Company, 'id' | 'timezone'>,
  products: Product[],
  deals: Deal[],
  nowIso: string,
  opts: { keepIds?: string[]; all?: boolean } = {},
): Product[] {
  if (!deals.length) return [...products];
  const clock = localClock(company.timezone, nowIso);
  // One section with a legacy "Deals" category of plain menu items, whatever its spelling.
  const dealCategory =
    products.find((p) => /^deals?$/i.test(p.category.trim()))?.category ?? 'Deals';
  const productIds = new Set(products.map((p) => p.id));
  const keep = new Set(opts.keepIds ?? []);
  const entries = deals
    .filter((deal) => deal.companyId === company.id && !productIds.has(deal.id))
    .sort((a, b) => a.position - b.position || byName(a.name, b.name))
    .flatMap((deal) => {
      const state = dealState(deal, products, clock);
      const gone = state === 'paused' || state === 'ended';
      return gone && !opts.all && !keep.has(deal.id)
        ? []
        : [dealProduct(deal, state, clock, dealCategory)];
    });
  return [...entries, ...products];
}
