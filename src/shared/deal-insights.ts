import type { Deal, Product } from './types';
import { daysText } from './deals';
import { windowTest, type Window } from './hours';

// What the Deals tab works out for an owner: the price if bought separately and how a deal's
// times sit against opening hours. Only the dashboard imports this file, so these helpers never
// reach the menu page (an old phone downloads only what the page itself uses).

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = 7 * 1440;

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
