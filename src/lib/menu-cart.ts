import type { Cart, CartItem, Company, Product } from '../shared/types';
import type { PublicMenu } from '../shared/menu';
import { quoteCart, type CartQuote } from '../domain/pricing';

// The menu page's cart, kept in this tab only (sessionStorage), and a price preview that uses
// the same pricing code as the server. The server always prices the order again.

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
  const products = menu.categories.flatMap((category) =>
    category.items.map(
      (item) =>
        ({ ...item, companyId: menu.slug, category: category.name, aliases: [] }) as Product,
    ),
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

// Private browsing and some in-app browsers refuse storage: the page then works without it.
const key = (slug: string, part: 'cart' | 't') => `orderly.menu.${slug}.${part}`;
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
