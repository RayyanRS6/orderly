import { botConfig, paymentMethods } from '../shared/bot';
import type {
  Cart,
  Company,
  Conversation,
  Language,
  Order,
  Product,
  TurnExplanation,
} from '../shared/types';
import { money } from '../shared/types';
import type { WebCart } from '../shared/menu';
import { CartError, normalizeText, quoteCart, type CartQuote } from './pricing';
import { buildOrder, isOpen, noticeLanguage, orderReceivedText } from './engine';

/** Pure rules for orders placed on the public menu page. The server only stores the result. */
export type MenuOrderErrorCode =
  | 'closed'
  | 'bot_off'
  | 'staff'
  | 'blocked'
  | 'invalid'
  | 'too_large'
  | 'unavailable'
  | 'price_changed';
export class MenuOrderError extends Error {
  constructor(
    readonly code: MenuOrderErrorCode,
    message: string,
    readonly total?: number,
  ) {
    super(message);
  }
}

const say = (lang: Language, en: string, ur: string, roman: string) =>
  lang === 'ur' ? ur : lang === 'roman-ur' ? roman : en;

/** Checks a page cart against the business's rules and prices it. */
export function quoteWebCart(
  company: Company,
  products: Product[],
  web: WebCart,
): { cart: Cart; quote: CartQuote } {
  if (!web.items.length || web.items.length > 40)
    throw new MenuOrderError('invalid', 'Please choose between 1 and 40 items.');
  const offered = botConfig(company).fulfillment;
  if (!['pickup', 'delivery'].includes(web.fulfillment))
    throw new MenuOrderError('invalid', 'Choose pickup or delivery.');
  if (offered !== 'both' && web.fulfillment !== offered)
    throw new MenuOrderError('invalid', `This restaurant currently offers ${offered} only.`);
  const customerName = web.customerName.trim();
  if (customerName.length < 2 || customerName.length > 80)
    throw new MenuOrderError('invalid', 'Please give a name between 2 and 80 characters.');
  const cart: Cart = {
    items: web.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      ...(item.variantId && { variantId: item.variantId }),
      modifierIds: [...item.modifierIds],
      notes: '',
    })),
    fulfillment: web.fulfillment,
    customerName,
    revision: 0,
    status: 'building',
  };
  if (web.fulfillment === 'delivery') {
    const address = web.address?.trim() ?? '';
    if (address.length < 5 || address.length > 400)
      throw new MenuOrderError(
        'invalid',
        'Please give a complete address between 5 and 400 characters.',
      );
    const zone = company.deliveryZones.find(
      (z) => normalizeText(z.name) === normalizeText(web.zone ?? ''),
    );
    if (!zone)
      throw new MenuOrderError(
        'invalid',
        `Choose a delivery area: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
      );
    cart.address = address;
    cart.zone = zone.name;
  }
  try {
    return { cart, quote: quoteCart(company, products, cart) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Please check your order.';
    // Pricing says which kind of problem it is; the wording is only a fallback for other errors.
    const code =
      error instanceof CartError
        ? error.kind
        : /unavailable/i.test(message)
          ? 'unavailable'
          : 'invalid';
    throw new MenuOrderError(code, message);
  }
}

/**
 * The order, the customer's chat as it is after the order, and the confirmation sent to them.
 * A personal-link order adds only the confirmation; an order code also adds the customer's
 * message, which (being a real message) moves lastInboundAt.
 */
export function buildWebOrder(
  company: Company,
  products: Product[],
  conversation: Conversation,
  web: WebCart,
  options: {
    now: string;
    submissionKey: string;
    expectedTotal?: number;
    customerMessage?: { id: string; text: string };
  },
): { conversation: Conversation; order: Order; reply: string; replyId: string } {
  if (conversation.companyId !== company.id) throw new Error('Company access denied.');
  if (conversation.channel !== 'whatsapp')
    throw new MenuOrderError('invalid', 'Menu page orders are for WhatsApp chats only.');
  if (!company.botEnabled)
    throw new MenuOrderError('bot_off', 'Online ordering is paused right now.');
  if (!isOpen(company, options.now))
    throw new MenuOrderError(
      'closed',
      `We’re closed right now. Ordering hours are ${company.openingHours.start}–${company.openingHours.end}.`,
    );
  if (conversation.blocked)
    throw new MenuOrderError('blocked', 'Ordering isn’t available for this chat.');
  if (conversation.mode !== 'bot')
    throw new MenuOrderError(
      'staff',
      'Our team is chatting with you on WhatsApp. Continue there to order.',
    );
  const { cart, quote } = quoteWebCart(company, products, web);
  if (options.expectedTotal !== undefined && options.expectedTotal !== quote.total)
    throw new MenuOrderError(
      'price_changed',
      `Prices changed since you opened the menu. The new total is ${money(quote.total)}.`,
      quote.total,
    );
  const lang = noticeLanguage(company, conversation, '');
  const order = buildOrder(
    company,
    conversation,
    cart,
    quote,
    options.now,
    options.submissionKey,
    'menu_page',
  );
  const lines = quote.items
    .map(
      (item) =>
        `${item.quantity} × ${item.name}${item.variant ? ` (${item.variant})` : ''}${item.modifiers.length ? ` + ${item.modifiers.join(', ')}` : ''} — ${money(item.total)}`,
    )
    .join('\n');
  const reply = [
    say(
      lang,
      'You ordered from our menu page:',
      'آپ نے ہمارے مینو پیج سے آرڈر کیا:',
      'Aap ne hamare menu page se order kiya:',
    ),
    lines,
    `\n${cart.fulfillment === 'delivery' ? `Delivery: ${cart.address} (${cart.zone})` : 'Pickup'} · ${cart.customerName}`,
    `${say(lang, 'Delivery fee', 'ڈیلیوری فیس', 'Delivery fee')}: ${money(quote.deliveryFee)}`,
    `${say(lang, 'Total', 'کل رقم', 'Total')}: ${money(quote.total)}`,
    `\n${orderReceivedText(lang, order, paymentMethods(company))}`,
  ].join('\n');
  if (reply.length > 3500)
    throw new MenuOrderError(
      'too_large',
      'This order is too large for one message. Please order in WhatsApp instead.',
    );
  const next = structuredClone(conversation);
  next.cart = {
    ...cart,
    revision: conversation.cart.revision + 1,
    status: 'submitted',
    orderId: order.id,
  };
  delete next.pendingItemChoice;
  delete next.pendingDealChoice;
  next.customerName = cart.customerName!;
  if (options.customerMessage) {
    next.messages.push({
      id: options.customerMessage.id,
      role: 'customer',
      text: options.customerMessage.text.slice(0, 4000),
      createdAt: options.now,
    });
    next.lastInboundAt = new Date(
      Math.max(Date.parse(conversation.lastInboundAt), Date.parse(options.now)),
    ).toISOString();
  }
  const replyId = options.customerMessage
    ? `${options.customerMessage.id}:reply`
    : `menu-order:${order.id}`;
  const explanation: TurnExplanation = {
    v: 1,
    channel: 'whatsapp',
    config: {
      target: 'live',
      revision: company.bot?.revision ?? 0,
      version: company.bot?.published?.version,
    },
    provider: company.ai.provider,
    model: company.ai.model,
    catalogSource: company.catalogSource,
    ai: { called: false, skipped: 'menu_page' },
    steps: ['menu_page_order'],
    decision: { parts: ['engine'], modelText: 'none', corrections: [] },
    outcome: 'order',
    orderReference: order.reference,
  };
  next.messages.push({
    id: replyId,
    role: 'assistant',
    text: reply,
    createdAt: options.now,
    explanation,
  });
  next.version = conversation.version + 1;
  next.updatedAt = options.now;
  return { conversation: next, order, reply, replyId };
}
