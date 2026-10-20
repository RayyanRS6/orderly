import type { Cart, CartItem, Company, Product } from '../shared/types';
import {
  normalizeTypedPhone,
  type PublicMenu,
  type PublicMenuDeal,
  type PublicMenuItem,
  type WebCart,
} from '../shared/menu';
import { quoteCart, type CartQuote } from '../domain/pricing';
import { ApiError } from './api';

// The menu page's cart and order code, kept in this tab only (sessionStorage), a price preview
// that uses the same pricing code as the server (which always prices the order again), and the
// page's small decisions about what a customer sees when something goes wrong.

const sameOptions = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Adds a line, or more of an identical line (same item, option and extras). */
export function addLine(
  items: CartItem[],
  line: { productId: string; quantity: number; variantId?: string; modifierIds: string[] },
): CartItem[] {
  const modifierIds = [...line.modifierIds].sort();
  const same = items.find(
    (item) =>
      item.productId === line.productId &&
      item.variantId === line.variantId &&
      sameOptions(item.modifierIds, modifierIds),
  );
  if (same)
    return items.map((item) =>
      item === same ? { ...item, quantity: Math.min(50, item.quantity + line.quantity) } : item,
    );
  return [
    ...items,
    {
      productId: line.productId,
      quantity: Math.min(50, line.quantity),
      ...(line.variantId && { variantId: line.variantId }),
      modifierIds,
      notes: '',
    },
  ];
}
/** A quantity of 0 removes the line. */
export function setQuantity(items: CartItem[], index: number, quantity: number): CartItem[] {
  if (quantity < 1) return items.filter((_, i) => i !== index);
  return items.map((item, i) =>
    i === index ? { ...item, quantity: Math.min(50, quantity) } : item,
  );
}
export const count = (items: CartItem[]) => items.reduce((sum, item) => sum + item.quantity, 0);

/** The total the page shows, or why the cart cannot be priced yet. */
export function previewQuote(
  menu: PublicMenu,
  cart: Pick<Cart, 'items' | 'fulfillment' | 'zone'>,
): { quote?: CartQuote; error?: string } {
  const company = { id: menu.slug, deliveryZones: menu.restaurant.deliveryZones } as Company;
  // A deal keeps its public block: its picks with their prices and the includes the order line
  // copies, so a deal line here is the line the server makes.
  const products = menu.categories.flatMap((category) =>
    category.items.map((item): Product => ({
      ...item,
      companyId: menu.slug,
      category: category.name,
      aliases: [],
    })),
  );
  try {
    return {
      quote: quoteCart(company, products, {
        items: cart.items,
        fulfillment: cart.fulfillment,
        zone: cart.zone,
        revision: 0,
        status: 'building',
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Please check your order.' };
  }
}

/**
 * Where a deal's picks stand (picks: option id by group id): the first group still to pick (-1
 * when none), the price of one with the picks' extra charges, and the picked ids in group order.
 */
export function dealPicked(deal: PublicMenuDeal, price: number, picks: Record<string, string>) {
  const chosen = deal.choices.map((group) => group.options.find((o) => o.id === picks[group.id]));
  return {
    next: chosen.findIndex((option) => !option),
    unit: price + chosen.reduce((sum, option) => sum + (option?.price ?? 0), 0),
    modifierIds: chosen.flatMap((option) => (option ? [option.id] : [])),
  };
}
/** A deal line's picks in the deal's group order ("Drink: Sprite"), whatever order the ids are in. */
export const dealPicks = (deal: PublicMenuDeal, modifierIds: string[]) =>
  deal.choices.flatMap((group) => {
    const option = group.options.find((o) => modifierIds.includes(o.id));
    return option ? [`${group.name}: ${option.name}`] : [];
  });
/** Why an item can't be ordered: a deal outside its times is on again later, not sold out. */
export const notOrderable = (item: Pick<PublicMenuItem, 'deal'>) =>
  item.deal?.state === 'later' ? 'Not on now' : 'Sold out';
/** Whether the menu (or, with ids, those of its items) has a deal that runs only at set times. */
export const hasTimedDeal = (menu: PublicMenu | undefined, ids?: string[]) =>
  !!menu?.categories.some((category) =>
    category.items.some((item) => item.deal?.when && (!ids || ids.includes(item.id))),
  );

/** A typed number the way the customer knows it ("+92 300 1234567"), or undefined if invalid. */
export function typedPhoneLabel(value: string): string | undefined {
  const digits = normalizeTypedPhone(value);
  if (!digits) return undefined;
  const pakistan = /^92(3\d{2})(\d{7})$/.exec(digits);
  return pakistan ? `+92 ${pakistan[1]} ${pakistan[2]}` : `+${digits}`;
}

/** The first thing to fix before Place order. The number is checked the way the server does. */
export function checkoutProblem(form: {
  mode?: 'link' | 'public';
  name: string;
  fulfillment: WebCart['fulfillment'];
  zone: string;
  address: string;
  phone: string;
}): string | undefined {
  if (form.name.trim().length < 2) return 'Please add your name.';
  if (form.fulfillment === 'delivery' && !form.zone) return 'Please choose your delivery area.';
  if (form.fulfillment === 'delivery' && form.address.trim().length < 5)
    return 'Please add your full delivery address.';
  if (form.mode === 'public' && !normalizeTypedPhone(form.phone))
    return 'Please enter your WhatsApp number, for example 0300 1234567.';
  return undefined;
}

const OFFLINE = 'Check your connection and try again.';
/** Why the menu didn't load, in words a customer understands (never "Failed to fetch"). */
export function menuLoadFailure(error: unknown): { message: string; missing: boolean } {
  return error instanceof ApiError
    ? { message: error.message, missing: error.status === 404 }
    : { message: OFFLINE, missing: false };
}

export type OrderFailure =
  | { kind: 'price_changed'; message: string }
  | { kind: 'link_ended' }
  | { kind: 'stopped' }
  | { kind: 'chat'; state: 'staff' | 'blocked' | 'bot_off' | 'closed' }
  | { kind: 'error'; message: string; reloadMenu: boolean };
/** What the page does when Place order fails. */
export function orderFailure(error: unknown, mode?: 'link' | 'public'): OrderFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'error',
      message: `We couldn’t reach the restaurant. ${OFFLINE}`,
      reloadMenu: false,
    };
  const { code, status } = error;
  if (code === 'price_changed') return { kind: 'price_changed', message: error.message };
  // Only a personal link ends, and the server says so with 410. A 422 'invalid' is a typo or
  // a menu change the customer can fix, so its message is shown and checkout stays open.
  if (mode === 'link' && status === 410) return { kind: 'link_ended' };
  if (mode === 'public' && (code === 'no_whatsapp' || code === 'bot_off' || code === 'closed'))
    return { kind: 'stopped' };
  if (code === 'staff' || code === 'blocked' || code === 'bot_off' || code === 'closed')
    return { kind: 'chat', state: code };
  // A dish sold out or removed, or an option or delivery area changed: a fresh menu marks it.
  return {
    kind: 'error',
    message: error.message,
    reloadMenu: status === 422 && (code === 'unavailable' || code === 'invalid'),
  };
}

// Private browsing and some in-app browsers refuse storage: the page then works without it.
const key = (slug: string, part: 'cart' | 't' | 'draft') => `orderly.menu.${slug}.${part}`;
export function loadCart(slug: string): CartItem[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(slug, 'cart')) ?? '[]');
    return Array.isArray(value) ? value.slice(0, 40) : [];
  } catch {
    return [];
  }
}
export function saveCart(slug: string, items: CartItem[]) {
  try {
    if (items.length) sessionStorage.setItem(key(slug, 'cart'), JSON.stringify(items));
    else sessionStorage.removeItem(key(slug, 'cart'));
  } catch {
    // Not saved: the cart still works until the tab closes.
  }
}
export function loadToken(slug: string): string | undefined {
  try {
    return sessionStorage.getItem(key(slug, 't')) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveToken(slug: string, token?: string) {
  try {
    if (token) sessionStorage.setItem(key(slug, 't'), token);
    else sessionStorage.removeItem(key(slug, 't'));
  } catch {
    // The link works for this visit only.
  }
}

/** An Instagram/QR order waiting for its code to be sent from the customer's WhatsApp. */
export interface DraftCode {
  code: string;
  expiresAt: string;
  whatsappUrl: string;
  /** Set by the page: the order has a deal that runs only at set times, so the code can't wait. */
  timedDeal?: true;
}
/**
 * The order code, until it expires. Opening WhatsApp often reloads this tab, so the code and
 * its cart are kept; an expired code takes its cart with it.
 */
export function loadDraft(slug: string, now = Date.now()): DraftCode | undefined {
  try {
    const value: Partial<Record<keyof DraftCode, unknown>> | null = JSON.parse(
      sessionStorage.getItem(key(slug, 'draft')) ?? 'null',
    );
    if (!value) return undefined;
    const { code, expiresAt, whatsappUrl, timedDeal } = value;
    if (
      typeof code === 'string' &&
      typeof expiresAt === 'string' &&
      typeof whatsappUrl === 'string' &&
      whatsappUrl.startsWith('https://wa.me/') &&
      Date.parse(expiresAt) > now
    )
      return { code, expiresAt, whatsappUrl, ...(timedDeal === true && { timedDeal }) };
    sessionStorage.removeItem(key(slug, 'draft'));
    sessionStorage.removeItem(key(slug, 'cart'));
  } catch {
    // Unreadable: the page opens on the menu.
  }
  return undefined;
}
export function saveDraft(slug: string, draft?: DraftCode) {
  try {
    if (draft) sessionStorage.setItem(key(slug, 'draft'), JSON.stringify(draft));
    else sessionStorage.removeItem(key(slug, 'draft'));
  } catch {
    // The code shows until the tab reloads.
  }
}
