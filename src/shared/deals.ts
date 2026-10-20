import type { Company, Deal, DealSchedule, DealState, Language, Product } from './types';
import {
  dealEnded,
  dealOpenAt,
  isNightWindow,
  localClock,
  toMinute,
  windowTest,
  type Clock,
  type Window,
} from './hours';

// Deals as the system sells them: their state at a moment, how their times read, and the menu
// entries they become. Only types and hours are imported, so the menu page and the dashboard
// can load it without the engine.

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
const WEEK = 7 * 1440;
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

// Listed days as runs in week order from Monday: "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri".
function daysText(days: number[], lang: Language): string {
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
 * ' · until 14 Aug' when it has an end date. '' with no schedule.
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
  if (schedule.startDate && (!clock || clock.date < schedule.startDate)) {
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

/** "You save": the owner's regular price minus the deal price, when above 0. */
export function dealSavings(deal: {
  price: number;
  regularPrice?: number;
  deal?: { regularPrice?: number };
}): number | undefined {
  const regular = deal.deal ? deal.deal.regularPrice : deal.regularPrice;
  const saving = typeof regular === 'number' ? regular - deal.price : NaN;
  return Number.isFinite(saving) && saving > 0 ? saving : undefined;
}

/**
 * "Price if bought separately" from the linked menu items: quantity × the size's price, or the
 * item's price when it has no sizes. Items it can't price are listed for the editor, as
 * "Drink (not linked)" or "Fries (no size)".
 */
export function dealsWorkItOut(
  deal: Pick<Deal, 'items'>,
  products: Product[],
): { total: number; notCounted: string[] } {
  let total = 0;
  const notCounted: string[] = [];
  for (const item of deal.items) {
    const product = item.productId ? products.find((p) => p.id === item.productId) : undefined;
    const variant = product?.variants.find((v) => v.id === item.variantId);
    const price = variant ? variant.price : product?.variants.length ? undefined : product?.price;
    if (price === undefined)
      notCounted.push(`${item.name} (${product ? 'no size' : 'not linked'})`);
    else total += item.quantity * price;
  }
  return { total, notCounted };
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * How much of a deal's times fall inside opening hours, over one week of minutes (dates are
 * ignored), with the closed parts in words ("Sun night 00:00–02:00"). For dashboard warnings
 * only: ordering is refused while closed anyway.
 */
export function openingOverlap(
  schedule: Window,
  openingHours: Window,
): { dealMinutes: number; overlapMinutes: number; closedParts: string[] } {
  const inDeal = windowTest(schedule),
    open = windowTest(openingHours);
  const closed: boolean[] = [];
  let dealMinutes = 0,
    overlapMinutes = 0;
  for (let i = 0; i < WEEK; i++) {
    const clock = { day: Math.floor(i / 1440), minute: i % 1440 };
    const on = inDeal(clock),
      both = on && open(clock);
    if (on) dealMinutes++;
    if (both) overlapMinutes++;
    closed.push(on && !both);
  }
  return { dealMinutes, overlapMinutes, closedParts: closedParts(closed) };
}

// Runs of closed minutes in words. The same times on several days share one line
// ("Mon–Fri 22:00–23:00"); a run wholly before 06:00 is named as the night before.
function closedParts(closed: boolean[]): string[] {
  if (closed.every(Boolean)) return ['All day every day'];
  const starts: number[] = [];
  for (let i = 0; i < WEEK; i++) if (closed[i] && !closed[(i + WEEK - 1) % WEEK]) starts.push(i);
  // Monday first, as days are listed everywhere else.
  starts.sort((a, b) => ((a + WEEK - 1440) % WEEK) - ((b + WEEK - 1440) % WEEK));
  const groups = new Map<string, number[]>();
  const add = (key: string, day: number) => groups.set(key, [...(groups.get(key) ?? []), day]);
  const spans: string[] = [];
  for (const start of starts) {
    let length = 0;
    while (length < WEEK && closed[(start + length) % WEEK]) length++;
    const day = Math.floor(start / 1440),
      from = start % 1440,
      end = (start + length) % WEEK;
    if (from === 0 && length % 1440 === 0)
      for (let d = 0; d < length / 1440; d++) add('all', (day + d) % 7);
    else if (length >= 1440)
      spans.push(
        `${SHORT_DAYS[day]} ${hhmm(from)} – ${SHORT_DAYS[Math.floor(end / 1440)]} ${hhmm(end % 1440)}`,
      );
    else if (from + length <= 6 * 60) add(`night ${hhmm(from)}–${hhmm(end % 1440)}`, (day + 6) % 7);
    else add(`${hhmm(from)}–${hhmm(end % 1440)}`, day);
  }
  const lines = [...groups].map(([key, days]) => {
    const every = new Set(days).size === 7;
    const named = daysText(days, 'en');
    if (key === 'all') return every ? 'All day every day' : `All day ${named}`;
    if (key.startsWith('night ')) return every ? `Every ${key}` : `${named} ${key}`;
    return every ? `Every day ${key}` : `${named} ${key}`;
  });
  return [...lines, ...spans];
}
