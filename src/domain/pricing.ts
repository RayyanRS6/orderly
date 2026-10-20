import type { Cart, CartItem, Company, OrderLine, Product, ProductDeal } from '../shared/types';

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

/**
 * Why a cart can't be priced. `kind` says what the menu page should do ('unavailable' reloads
 * the menu), so a reworded message can never change it. The engine shows the message.
 */
export class CartError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export const safeMoney = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new CartError('invalid', 'Invalid catalog price. Please ask staff for help.');
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
    throw new CartError('invalid', 'Your cart is empty. Choose something from the menu first.');
  if (cart.items.length > 40)
    throw new CartError('invalid', 'Please ask staff to help with this large order.');
  const items: OrderLine[] = cart.items.map((item) => {
    const product = products.find((p) => p.id === item.productId && p.companyId === company.id);
    if (product?.deal) return dealLine(product, product.deal, item);
    if (!product || !product.available)
      throw new CartError(
        'unavailable',
        `${product?.name ?? 'An item'} is unavailable. Remove it or ask staff for help.`,
      );
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50)
      throw new CartError('invalid', 'Choose a quantity between 1 and 50.');
    const variant = product.variants.find((v) => v.id === item.variantId);
    if ((item.variantId && !variant) || (product.variants.length && !variant))
      throw new CartError(
        'invalid',
        `Choose an option for ${product.name}: ${product.variants.map((v) => v.name).join(', ')}.`,
      );
    if (new Set(item.modifierIds).size !== item.modifierIds.length)
      throw new CartError('invalid', 'The same extra cannot be selected twice.');
    const modifiers = item.modifierIds.map((id) => {
      const option = product.modifiers.find((m) => m.id === id);
      if (!option) throw new CartError('invalid', `Invalid extra for ${product.name}.`);
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
      throw new CartError(
        'invalid',
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

/**
 * A deal is one line at the deal price plus the extra charge of each pick. modifierIds hold one
 * option id per choice group; the line lists the picks in the deal's group order, whatever
 * order the ids came in, so the hash never depends on it. The hash leaves out savings, state,
 * times and description: none of them changes what the customer pays for.
 */
function dealLine(product: Product, deal: ProductDeal, item: CartItem): OrderLine {
  const { name } = product;
  if (!product.available) {
    const why =
      deal.state === 'later' && deal.when
        ? ` It is on ${deal.when}.`
        : deal.state === 'ended'
          ? ' It has ended.'
          : deal.state === 'sold_out'
            ? ' It is sold out.'
            : '';
    throw new CartError(
      'unavailable',
      `${name} is unavailable right now.${why} Remove it to continue.`,
    );
  }
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50)
    throw new CartError('invalid', 'Choose a quantity between 1 and 50.');
  if (item.variantId) throw new CartError('invalid', `Invalid option for ${name}.`);
  const ids = item.modifierIds;
  if (new Set(ids).size !== ids.length)
    throw new CartError('invalid', 'The same choice cannot be selected twice.');
  const known = new Set(deal.choices.flatMap((group) => group.options.map((o) => o.id)));
  if (ids.some((id) => !known.has(id)))
    throw new CartError('invalid', `Invalid choice for ${name}.`);
  const picks = deal.choices.map((group) => {
    const picked = group.options.filter((o) => ids.includes(o.id));
    if (picked.length > 1) throw new CartError('invalid', `Choose one ${group.name} for ${name}.`);
    if (!picked.length)
      throw new CartError(
        'invalid',
        `Choose ${group.name} for ${name}: ${group.options.map((o) => o.name).join(', ')}.`,
      );
    return { group: group.name, option: picked[0]! };
  });
  const unitPrice = safeMoney(
    safeMoney(product.price) + picks.reduce((sum, pick) => sum + safeMoney(pick.option.price), 0),
  );
  const choices = picks.map((pick) => ({ group: pick.group, option: pick.option.name }));
  return {
    productId: product.id,
    name,
    quantity: item.quantity,
    unitPrice,
    // Every order renderer already prints `variant`, so the picks show with no change there.
    ...(choices.length > 0 && {
      variant: choices.map((c) => `${c.group}: ${c.option}`).join(', '),
    }),
    modifiers: [],
    notes: item.notes.slice(0, 300),
    total: safeMoney(unitPrice * item.quantity),
    choices,
    includes: [...deal.includes],
  };
}
