import type { CartItem, DeliveryZone, Order } from './types';

// The public menu page (/m/<slug>): shapes shared by the server and the page, and small
// helpers with no dependencies, so the page's own chunk stays light.

/** One fixed link per business. The slug is chosen once and never changes. */
export interface MenuLink {
  companyId: string;
  slug: string;
  enabled: boolean;
  updatedAt: string;
}
/** What the owner's Menu page card shows. */
export interface MenuLinkStatus {
  enabled: boolean;
  slug?: string;
  url?: string;
  personalLinks: true;
  whatsappNumber?: string;
  notes: string[];
}
export interface PublicMenuOption {
  id: string;
  name: string;
  price: number;
}
export interface PublicMenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  available: boolean;
  emoji: string;
  imageUrl?: string;
  variants: PublicMenuOption[];
  modifiers: PublicMenuOption[];
}
export interface PublicMenu {
  slug: string;
  restaurant: {
    name: string;
    address: string;
    phone: string;
    timezone: string;
    openingHours: { start: string; end: string; days: number[] };
    deliveryZones: DeliveryZone[];
    fulfillment: 'both' | 'pickup' | 'delivery';
    currency: 'PKR';
  };
  categories: { name: string; items: PublicMenuItem[] }[];
  ordering: {
    open: boolean;
    botOn: boolean;
    /** Instagram/QR customers can order: they type their number and confirm in WhatsApp. */
    publicOrdering: boolean;
    reason?: 'closed' | 'bot_off' | 'no_whatsapp' | 'unavailable';
    whatsappNumber?: string;
  };
  generatedAt: string;
}
export interface WebCart {
  items: CartItem[];
  fulfillment: 'pickup' | 'delivery';
  customerName: string;
  address?: string;
  zone?: string;
}
export interface MenuSession {
  state:
    'ready' | 'expired' | 'used' | 'stale' | 'invalid' | 'staff' | 'blocked' | 'closed' | 'bot_off';
  phoneMasked?: string;
  name?: string;
  reference?: string;
  whatsappUrl?: string;
}
export type WebOrderClaim =
  | { kind: 'link'; nonce: string; expiresAt: string; keys: string[] }
  | { kind: 'draft'; draftId: string; keys: string[] };
export type WebOrderOutcome =
  | { ok: true; order: Order }
  | { ok: false; reason: 'duplicate'; order: Order }
  | {
      ok: false;
      reason: 'used' | 'expired' | 'bot_off' | 'blocked' | 'staff' | 'conversation_changed';
    };
/** An order started on the page. Only keyed hashes of the code and phone are kept. */
export interface MenuDraft {
  id: string;
  companyId: string;
  codeHash?: string;
  phoneHash?: string;
  cart?: WebCart;
  quotedTotal: number;
  expiresAt: string;
  usedAt?: string;
  orderId?: string;
  conversationId?: string;
}
export interface MenuDraftInput {
  id: string;
  companyId: string;
  codeHash: string;
  phoneHash: string;
  /** The visitor's network address as a keyed hash (clientKey), never a raw IP. */
  ipKey?: string;
  cart: WebCart;
  quotedTotal: number;
}
export type MenuDraftResult =
  { ok: true; expiresAt: string } | { ok: false; reason: 'busy' | 'busy_source' | 'collision' };

export const MENU_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PHOTO_URL_RE = /^https:\/\/[^\s"'<>]+$/i;
export const isPhotoUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 500 && PHOTO_URL_RE.test(value);

/** Categories in first-seen order, with any "Deal" or "Deals" category first. */
export function sortMenuCategories<T extends { category: string }>(
  items: T[],
): { name: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }
  const deal = (name: string) => /^deals?$/i.test(name.trim());
  return [...groups]
    .map(([name, list]) => ({ name, items: list }))
    .sort((a, b) => Number(deal(b.name)) - Number(deal(a.name)));
}

/** "+92 ••• 4567": enough to recognise your own number, not enough to read someone else's. */
export const maskPhone = (digits: string) => `+${digits.slice(0, 2)} ••• ${digits.slice(-4)}`;

/** Digits of a number a customer typed, or undefined. 03xx numbers are Pakistani (+92). */
export function normalizeTypedPhone(value: string): string | undefined {
  // Typed with + or 00, the number already starts with its country code.
  const international = /^\s*(?:\+|00)/.test(value);
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^03\d{9}$/.test(digits)) digits = `92${digits.slice(1)}`;
  // A Pakistani mobile typed without its 0 ('300 1234567'), or with it after +92 ('+92 0300…').
  else if (!international && /^3\d{9}$/.test(digits)) digits = `92${digits}`;
  else if (/^920(3\d{9})$/.test(digits)) digits = `92${digits.slice(3)}`;
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : undefined;
}
export const waMeUrl = (digits: string, text?: string) =>
  `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

// Order codes: 8 characters without look-alikes (no I, O, 0 or 1), shown as OM-XXXX-XXXX. The
// hyphens are required, so ordinary words never look like a code.
export const MENU_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MENU_CODE_RE = /\bOM-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})\b/i;
export function menuCodeIn(text: string): string | undefined {
  const match = MENU_CODE_RE.exec(text);
  return match ? `${match[1]}${match[2]}`.toUpperCase() : undefined;
}
export const formatMenuCode = (code: string) => `OM-${code.slice(0, 4)}-${code.slice(4, 8)}`;
export const draftMessage = (code: string) =>
  `Hi! Please place my menu order. Code: ${formatMenuCode(code)}`;
