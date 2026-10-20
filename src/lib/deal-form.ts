import { useEffect, useState } from 'react';
import type { Company, Deal, DealSchedule, Product } from '../shared/types';
import { dealsWorkItOut, openingOverlap } from '../shared/deals';
import { dealEnded, isNightWindow, toMinute, type Clock, type Window } from '../shared/hours';
import { pollWhileVisible } from './polling';

// The Deals tab's editor form and the plain rules behind it: night chips, time presets, the
// form made from a saved deal and back, and the warnings a deal card shows. Nothing here draws
// anything, so each rule is tested on its own.

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** Monday first, as deal times are worded ("Mon–Fri"). */
export const CHIP_DAYS = [1, 2, 3, 4, 5, 6, 0];
export const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** At most this many choice groups, options per group and menu items offered while typing. */
export const MAX_CHOICES = 5;
export const MAX_OPTIONS = 25;
const MATCHES = 6;

/** A deal as the dashboard sends it: the server adds the business, position and save time. */
export type DealBody = Omit<Deal, 'id' | 'companyId' | 'position' | 'updatedAt'> & { id?: string };
/** One "What's included" row. `key` only tells rows apart on screen; it is never saved. */
export interface DealFormItem {
  key: string;
  name: string;
  quantity: number;
  productId?: string;
  variantId?: string;
}
/** An option row: `extra` is the typed rupees, blank meaning no extra charge. */
export interface DealFormOption {
  id: string;
  name: string;
  extra: string;
}
export interface DealFormChoice {
  id: string;
  name: string;
  options: DealFormOption[];
}
export interface DealForm {
  name: string;
  /** Rupees, as typed. */
  price: string;
  items: DealFormItem[];
  /** Rupees, as typed: only used once the owner typed it (regularTyped). */
  regularPrice: string;
  /** False while "Price if bought separately" follows Work it out (a new deal). */
  regularTyped: boolean;
  choices: DealFormChoice[];
  /** False: any time the restaurant is open (no schedule). */
  timed: boolean;
  /**
   * The ticked day chips as the owner sees them. For a night window (00:00–03:00) chip d is the
   * night that STARTS on day d, so it is stored as day d + 1 (shared/hours.ts). Kept as ticked, so
   * changing the times never moves a tick.
   */
  chips: number[];
  allDay: boolean;
  start: string;
  end: string;
  startDate: string;
  endDate: string;
  description: string;
  emoji: string;
  imageUrl: string;
  /** Other names, comma-separated. */
  aliases: string;
  available: boolean;
}

const unique = (days: number[]) => [...new Set(days)].sort((a, b) => a - b);
/** Ticked chips as stored days: a night window's chip d is stored as d + 1. */
export const chipsToDays = (chips: number[], window: Pick<Window, 'start' | 'end'>) =>
  unique(isNightWindow(window) ? chips.map((day) => (day + 1) % 7) : chips);
/** Stored days as chips, the other way round. */
export const daysToChips = (days: number[], window: Pick<Window, 'start' | 'end'>) =>
  unique(isNightWindow(window) ? days.map((day) => (day + 6) % 7) : days);

export const rupees = (paisa: number) => String(paisa / 100);
/** Typed rupees as paisa; NaN when it isn't a number. */
export const toPaisa = (text: string) =>
  text.trim() === '' ? NaN : Math.round(Number(text.trim()) * 100);
/** Comma-separated names (English or Urdu commas), trimmed, blanks and repeats left out. */
export function splitList(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[,،]/)
    .map((part) => part.trim())
    .filter((part) => {
      const key = part.toLowerCase();
      if (!part || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** "Deal N" with the lowest number no deal is called yet. */
export function nextDealName(deals: Pick<Deal, 'name'>[]): string {
  const taken = new Set(deals.map((deal) => deal.name.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`deal ${n}`)) n++;
  return `Deal ${n}`;
}

export function newDealForm(deals: Pick<Deal, 'name'>[], key: () => string): DealForm {
  return {
    name: nextDealName(deals),
    price: '',
    items: [{ key: key(), name: '', quantity: 1 }],
    regularPrice: '',
    regularTyped: false,
    choices: [],
    timed: false,
    chips: [...ALL_DAYS],
    allDay: true,
    start: '12:00',
    end: '15:00',
    startDate: '',
    endDate: '',
    description: '',
    emoji: '🎁',
    imageUrl: '',
    aliases: '',
    available: true,
  };
}

/** The editor's form for a saved deal. Group and option ids stay as they are. */
export function dealToForm(deal: Deal, key: () => string): DealForm {
  const schedule = deal.schedule;
  const timesSet = !!schedule && schedule.start !== schedule.end;
  return {
    name: deal.name,
    price: rupees(deal.price),
    items: deal.items.map((item) => ({ key: key(), ...item })),
    regularPrice: deal.regularPrice === undefined ? '' : rupees(deal.regularPrice),
    // A saved deal keeps what the owner saved, even an emptied box.
    regularTyped: true,
    choices: deal.choices.map((group) => ({
      id: group.id,
      name: group.name,
      options: group.options.map((option) => ({
        id: option.id,
        name: option.name,
        extra: option.price ? rupees(option.price) : '',
      })),
    })),
    timed: !!schedule,
    chips: schedule ? daysToChips(schedule.days, schedule) : [...ALL_DAYS],
    allDay: schedule ? !timesSet : true,
    start: timesSet ? schedule.start : '12:00',
    end: timesSet ? schedule.end : '15:00',
    startDate: schedule?.startDate ?? '',
    endDate: schedule?.endDate ?? '',
    description: deal.description,
    emoji: deal.emoji,
    imageUrl: deal.imageUrl ?? '',
    aliases: deal.aliases.join(', '),
    available: deal.available,
  };
}

/** The window the form describes: all day is stored as 00:00–00:00. */
export const formWindow = (form: Pick<DealForm, 'allDay' | 'start' | 'end'>) =>
  form.allDay ? { start: '00:00', end: '00:00' } : { start: form.start, end: form.end };

/** The schedule the form saves, or undefined for "any time we're open". */
export function formSchedule(form: DealForm): DealSchedule | undefined {
  if (!form.timed) return undefined;
  const window = formWindow(form);
  return {
    days: chipsToDays(form.chips, window),
    ...window,
    ...(form.startDate && { startDate: form.startDate }),
    ...(form.endDate && { endDate: form.endDate }),
  };
}

/**
 * "Price if bought separately" as it will be saved: what the owner typed, or (for a new deal
 * the owner hasn't typed it on) the Work it out total of the linked items.
 */
export function regularText(form: DealForm, products: Product[]): string {
  if (form.regularTyped) return form.regularPrice;
  const { total } = dealsWorkItOut({ items: namedItems(form) }, products);
  // Never at or below the deal price (no price typed yet compares false, so it shows).
  return total > 0 && !(total <= toPaisa(form.price)) ? rupees(total) : '';
}
const namedItems = (form: Pick<DealForm, 'items'>) => form.items.filter((item) => item.name.trim());

/** What the editor can't save yet, in the owner's words, or '' when it can be sent. */
export function formProblem(form: DealForm): string {
  if (!form.name.trim()) return 'Give the deal a name.';
  if (!Number.isFinite(toPaisa(form.price)) || toPaisa(form.price) < 0)
    return 'Enter the deal price.';
  if (!namedItems(form).length) return 'Add what the deal includes.';
  if (
    namedItems(form).some(
      (item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50,
    )
  )
    return 'Give each included item a number from 1 to 50.';
  for (const group of form.choices) {
    if (!group.name.trim()) return 'Name each choice, for example Drink.';
    if (group.options.filter((option) => option.name.trim()).length < 2)
      return `Give ${group.name.trim()} at least 2 options.`;
  }
  if (form.timed && !form.chips.length)
    return isNightWindow(formWindow(form))
      ? 'Choose at least one night.'
      : 'Choose at least one day.';
  if (form.timed && form.startDate && form.endDate && form.startDate > form.endDate)
    return 'The end date is before the start date.';
  return '';
}

/** The request body for POST /deals. `id` updates that deal; without it a new one is made. */
export function formToBody(form: DealForm, products: Product[], id?: string): DealBody {
  const schedule = formSchedule(form);
  const regular = regularText(form, products).trim();
  const imageUrl = form.imageUrl.trim();
  return {
    ...(id && { id }),
    name: form.name.trim(),
    description: form.description.trim(),
    emoji: form.emoji.trim() || '🎁',
    ...(imageUrl && { imageUrl }),
    aliases: splitList(form.aliases),
    price: toPaisa(form.price),
    ...(regular !== '' && { regularPrice: toPaisa(regular) }),
    items: namedItems(form).map(({ name, quantity, productId, variantId }) => ({
      name: name.trim(),
      quantity,
      ...(productId && { productId }),
      ...(productId && variantId && { variantId }),
    })),
    choices: form.choices.map((group) => ({
      id: group.id,
      name: group.name.trim(),
      options: group.options
        .filter((option) => option.name.trim())
        .map((option) => ({
          id: option.id,
          name: option.name.trim(),
          price: option.extra.trim() ? toPaisa(option.extra) : 0,
        })),
    })),
    available: form.available,
    ...(schedule && { schedule }),
  };
}

/** A saved deal sent back unchanged but for `changes` (the one-tap savings update). */
export function dealBody(deal: Deal, changes: Partial<DealBody> = {}): DealBody {
  const { companyId: _company, position: _position, updatedAt: _updated, ...body } = deal;
  return { ...body, ...changes };
}

type Fill = Partial<Pick<DealForm, 'timed' | 'chips' | 'allDay' | 'start' | 'end'>> &
  Pick<DealForm, 'startDate' | 'endDate'>;
/** Quick fills for "When". `today` is the restaurant's date ('YYYY-MM-DD'). */
export const WHEN_PRESETS: { id: string; label: string; fill: (today: string) => Fill }[] = [
  {
    id: 'lunch',
    label: 'Lunch (Mon–Fri 12:00–15:00)',
    fill: () => ({
      timed: true,
      chips: [1, 2, 3, 4, 5],
      allDay: false,
      start: '12:00',
      end: '15:00',
      startDate: '',
      endDate: '',
    }),
  },
  {
    id: 'late',
    label: 'Late night (every night 00:00–03:00)',
    fill: () => ({
      timed: true,
      chips: [...ALL_DAYS],
      allDay: false,
      start: '00:00',
      end: '03:00',
      startDate: '',
      endDate: '',
    }),
  },
  {
    id: 'day',
    label: 'One day',
    fill: (today) => ({
      timed: true,
      chips: [...ALL_DAYS],
      allDay: true,
      startDate: today,
      endDate: today,
    }),
  },
  {
    id: 'dates',
    label: 'Between dates (e.g. Ramadan)',
    fill: (today) => ({
      timed: true,
      chips: [...ALL_DAYS],
      allDay: true,
      startDate: today,
      endDate: '',
    }),
  },
];

/** Minutes a window lasts: all day is 24 hours, and one after midnight ends the next day. */
export function windowMinutes(start: string, end: string): number {
  const from = toMinute(start),
    to = toMinute(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return from === to ? 1440 : (to - from + 1440) % 1440;
}
/** 00:00 and 12:00 in words, the two a 12-hour phone picker mixes up. */
export const timeWords = (time: string) =>
  time === '00:00' ? 'midnight (00:00)' : time === '12:00' ? 'noon (12:00)' : time;
/** "Runs from noon (12:00) to 15:00.", or '' for all day. */
export function runsText(form: Pick<DealForm, 'allDay' | 'start' | 'end'>): string {
  if (form.allDay || form.start === form.end) return '';
  const overnight = toMinute(form.start) > toMinute(form.end);
  return `Runs from ${timeWords(form.start)} to ${timeWords(form.end)}${overnight ? ' the next day' : ''}.`;
}
/** A window over 12 hours is often noon picked for midnight on a 12-hour picker. */
export function longWindowNote(form: Pick<DealForm, 'allDay' | 'start' | 'end'>): string {
  if (form.allDay) return '';
  const minutes = windowMinutes(form.start, form.end);
  if (minutes <= 12 * 60 || minutes >= 1440) return '';
  const hours = Math.round((minutes / 60) * 10) / 10;
  const noon = form.start.startsWith('12:') || form.end.startsWith('12:');
  return `This runs ${hours} hours.${noon ? ' Did you mean 12 am (midnight)?' : ''}`;
}

/** "14 Aug 2026". */
export function dayWords(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match && MONTHS[Number(match[2]) - 1];
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : date;
}
/** Said when saving: the end date has passed, or the deal starts later. '' otherwise. */
export function scheduleNotice(schedule: DealSchedule | undefined, clock: Clock | undefined) {
  if (!schedule || !clock) return '';
  if (dealEnded(schedule, clock)) return 'Its end date has passed, so customers won’t see it.';
  if (schedule.startDate && clock.date < schedule.startDate)
    return `It starts on ${dayWords(schedule.startDate)}.`;
  return '';
}

const lower = (text: string) => text.trim().toLowerCase();
/**
 * Menu items and other deals already called by the deal's name or one of its other names: the
 * bot then has to ask which one the customer means.
 */
export function sameNameWarning(
  names: string[],
  products: Pick<Product, 'id' | 'name' | 'aliases'>[],
  deals: Pick<Deal, 'id' | 'name' | 'aliases'>[],
  selfId?: string,
): string {
  const wanted = new Set(names.map(lower).filter(Boolean));
  const clashes = (entry: { name: string; aliases: string[] }) =>
    [entry.name, ...entry.aliases].some((name) => wanted.has(lower(name)));
  const menu = products.filter(clashes).map((p) => p.name);
  const others = deals.filter((d) => d.id !== selfId && clashes(d)).map((d) => d.name);
  const parts = [
    ...(menu.length ? [`${menu.join(', ')} on your menu`] : []),
    ...(others.length ? [`${others.join(', ')} in your deals`] : []),
  ];
  return parts.length
    ? `Same name as ${parts.join(' and ')}. The bot will ask customers which one they mean.`
    : '';
}

/** The menu items a typed name may mean, best first: names that start with it, then the rest. */
export function menuMatches(query: string, products: Product[]): Product[] {
  const typed = lower(query);
  if (!typed) return [];
  const rank = (product: Product) => {
    const name = lower(product.name);
    if (name.startsWith(typed)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(typed))) return 1;
    if (name.includes(typed)) return 2;
    return product.aliases.some((alias) => lower(alias).includes(typed)) ? 3 : 4;
  };
  return products
    .map((product) => ({ product, rank: rank(product) }))
    .filter((match) => match.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.product.name.localeCompare(b.product.name))
    .slice(0, MATCHES)
    .map((match) => match.product);
}
/** The name a linked row shows by default: "Fries (Large)" once a size is chosen. */
export const linkedName = (product: Product, variantId?: string) => {
  const variant = product.variants.find((v) => v.id === variantId);
  return variant ? `${product.name} (${variant.name})` : product.name;
};

/** A copy of choice `index` with new ids, named "Drink 2" (and the first "Drink 1"), after its set. */
export function copyChoice(
  choices: DealFormChoice[],
  index: number,
  newId: () => string,
): DealFormChoice[] {
  const source = choices[index];
  if (!source || choices.length >= MAX_CHOICES) return choices;
  const trimmed = source.name.trim();
  const base = trimmed.replace(/\s+\d+$/, '') || 'Choice';
  const renamed = choices.map((group, i) =>
    i === index && !/\s\d+$/.test(trimmed) ? { ...group, name: `${base} 1` } : group,
  );
  const taken = new Set(renamed.map((group) => lower(group.name)));
  let n = 2;
  while (taken.has(lower(`${base} ${n}`))) n++;
  const copy: DealFormChoice = {
    id: newId(),
    name: `${base} ${n}`,
    options: source.options.map((option) => ({ ...option, id: newId() })),
  };
  // After the last choice of the same set, so "Drink 1", "Drink 2", "Drink 3" stay together.
  const sameSet = (group: DealFormChoice) =>
    lower(group.name.replace(/\s+\d+$/, '')) === lower(base);
  let at = index;
  while (at + 1 < renamed.length && sameSet(renamed[at + 1]!)) at++;
  return [...renamed.slice(0, at + 1), copy, ...renamed.slice(at + 1)];
}
/** Option rows from "Coke, Sprite, Fanta", skipping names the choice already has. */
export function optionsFromText(
  text: string,
  existing: DealFormOption[],
  newId: () => string,
): DealFormOption[] {
  const have = new Set(existing.map((option) => lower(option.name)).filter(Boolean));
  const added = splitList(text)
    .filter((name) => !have.has(lower(name)))
    .map((name) => ({ id: newId(), name, extra: '' }));
  return [...existing.filter((option) => option.name.trim()), ...added].slice(0, MAX_OPTIONS);
}

/** A linked item that is no longer on the menu, or whose size is gone. */
export const linkBroken = (item: Deal['items'][number], products: Product[]) => {
  if (!item.productId) return false;
  const product = products.find((p) => p.id === item.productId);
  return !product || (!!item.variantId && !product.variants.some((v) => v.id === item.variantId));
};
/** The menu item that makes a deal sold out (the first linked one that is sold out). */
export function soldOutItem(deal: Deal, products: Product[]): string | undefined {
  for (const item of deal.items) {
    if (!item.productId || linkBroken(item, products)) continue;
    const product = products.find((p) => p.id === item.productId)!;
    if (!product.available) return product.name;
  }
  return undefined;
}
/** The card's warning when the deal's times fall outside opening hours, or ''. */
export function openingWarning(
  schedule: DealSchedule | undefined,
  hours: Company['openingHours'] | undefined,
): string {
  if (!schedule || !hours) return '';
  const { overlapMinutes, closedParts } = openingOverlap(schedule, hours);
  if (!overlapMinutes) return 'Never while you’re open: customers can’t order it at these times.';
  // An all-day deal means "whenever we're open on those days": closed hours are expected.
  if (schedule.start === schedule.end || !closedParts.length) return '';
  return `You’re closed for part of this deal’s times: ${closedParts.join(', ')}. Customers can’t order it then.`;
}
/**
 * The Work it out total when every item can be priced and it differs from the saved "price if
 * bought separately", so the card can offer to update it. Undefined otherwise.
 */
export function staleRegularPrice(deal: Deal, products: Product[]): number | undefined {
  if (deal.regularPrice === undefined) return undefined;
  const { total, notCounted } = dealsWorkItOut(deal, products);
  return notCounted.length || total === deal.regularPrice ? undefined : total;
}

/** Deals in menu order: position, then name with numbers in order ("Deal 2" before "Deal 10"). */
export function sortDeals(deals: Deal[]): Deal[] {
  const names = new Intl.Collator('en', { numeric: true });
  return [...deals].sort((a, b) => a.position - b.position || names.compare(a.name, b.name));
}
/** The workspace with one saved deal put in (added, or replacing the one with its id). */
export function withDeal<T extends { deals?: Deal[] }>(current: T, saved: Deal): T {
  const deals = current.deals ?? [];
  return {
    ...current,
    deals: deals.some((deal) => deal.id === saved.id)
      ? deals.map((deal) => (deal.id === saved.id ? saved : deal))
      : [...deals, saved],
  };
}
/** The workspace with deals in this order (positions 1..N; deals left out follow). */
export function withOrder<T extends { deals?: Deal[] }>(current: T, ids: string[]): T {
  const rest = sortDeals(current.deals ?? []).filter((deal) => !ids.includes(deal.id));
  const order = [...ids, ...rest.map((deal) => deal.id)];
  return {
    ...current,
    deals: (current.deals ?? []).map((deal) => ({
      ...deal,
      position: order.indexOf(deal.id) + 1,
    })),
  };
}

/**
 * The time now, again every minute while the page is on screen and `active`, so a deal's
 * "On now" or "Later" follows the clock without reloading the workspace.
 */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return pollWhileVisible(() => setNow(Date.now()), 60_000);
  }, [active]);
  return now;
}
