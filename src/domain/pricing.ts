import type { Cart, Company, OrderLine, Product } from '../shared/types';

/** Prices and totals only. Kept free of the engine so the public menu page can load it alone. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[۰-۹٠-٩]/g, (digit) =>
      String(
        '۰۱۲۳۴۵۶۷۸۹'.includes(digit) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit),
      ),
    )
    .replace(/[\u064b-\u065f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export const safeMoney = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error('Invalid catalog price. Please ask staff for help.');
  return n;
};

export interface CartQuote {
  items: OrderLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  hash: string;
}

/** Variant prices replace the base price; modifier prices are added per unit. */
export function quoteCart(company: Company, products: Product[], cart: Cart): CartQuote {
  if (!cart.items.length)
    throw new Error('Your cart is empty. Choose something from the menu first.');
  if (cart.items.length > 40) throw new Error('Please ask staff to help with this large order.');
  const items: OrderLine[] = cart.items.map((item) => {
    const product = products.find((p) => p.id === item.productId && p.companyId === company.id);
    if (!product || !product.available)
      throw new Error(
        `${product?.name ?? 'An item'} is unavailable. Remove it or ask staff for help.`,
      );
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50)
      throw new Error('Choose a quantity between 1 and 50.');
    const variant = product.variants.find((v) => v.id === item.variantId);
    if ((item.variantId && !variant) || (product.variants.length && !variant))
      throw new Error(
        `Choose an option for ${product.name}: ${product.variants.map((v) => v.name).join(', ')}.`,
      );
    if (new Set(item.modifierIds).size !== item.modifierIds.length)
      throw new Error('The same extra cannot be selected twice.');
    const modifiers = item.modifierIds.map((id) => {
      const option = product.modifiers.find((m) => m.id === id);
      if (!option) throw new Error(`Invalid extra for ${product.name}.`);
      return option;
    });
    const unitPrice = safeMoney(
      safeMoney(variant?.price ?? product.price) +
        modifiers.reduce((sum, m) => sum + safeMoney(m.price), 0),
    );
    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPrice,
      variant: variant?.name,
      modifiers: modifiers.map((m) => m.name),
      notes: item.notes.slice(0, 300),
      total: safeMoney(unitPrice * item.quantity),
    };
  });
  let deliveryFee = 0;
  if (cart.fulfillment === 'delivery') {
    const zone = company.deliveryZones.find(
      (z) => normalizeText(z.name) === normalizeText(cart.zone ?? ''),
    );
    if (!zone)
      throw new Error(
        `Choose a delivery area: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
      );
    deliveryFee = safeMoney(zone.fee);
  }
  const subtotal = safeMoney(items.reduce((sum, item) => sum + item.total, 0));
  const total = safeMoney(subtotal + deliveryFee);
  // An exact canonical snapshot avoids relying on a lossy checksum for confirmation.
  const hash = JSON.stringify({
    companyId: company.id,
    items,
    subtotal,
    deliveryFee,
    total,
    fulfillment: cart.fulfillment,
    customerName: cart.customerName,
    address: cart.address,
    zone: cart.zone,
  });
  return { items, subtotal, deliveryFee, total, hash };
}
