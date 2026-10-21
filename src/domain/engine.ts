import { botConfig, offeredFulfillment, paymentMethods } from '../shared/bot';
import type {
  BotAction,
  BotConfig,
  Cart,
  Company,
  Conversation,
  Language,
  ModelResponse,
  ModelTextOutcome,
  Order,
  OrderLine,
  OrderStatus,
  PaymentMethod,
  Product,
  ReplyDecision,
  ReplyPart,
  TurnInput,
  TurnResult,
} from '../shared/types';
import { money } from '../shared/types';
import { effectiveAiLimits, MODEL_LIMITS } from '../shared/models';
import {
  CLAUSE_BREAK,
  clearQuantityNear,
  DEAL_WORDS,
  dealWordCount,
  findDealMentions,
  mentionsQuantity,
  normalizeCatalogText,
  ONLY_DEAL_WORDS,
  quantityNear,
  quantityOfMention,
  resolveItemMention,
  resolvePendingItemChoice,
} from './menu-resolver';
import { leftToRight } from './disclosure';
import { inWindow, localClock, toMinute, turnInstant, type Clock } from '../shared/hours';
import { dealSavings, dealWhen } from '../shared/deals';
import { normalizeText as normalize, quoteCart, type CartQuote } from './pricing';
export { quoteCart, type CartQuote } from './pricing';

/** Pure application rules. Models can suggest tools, never calculate or commit orders. */
export const emptyCart = (): Cart => ({ items: [], revision: 0, status: 'building' });

// Deterministic identifiers make a replay of an event produce the same order.
function idFor(value: string): string {
  const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (const char of value)
    for (let i = 0; i < words.length; i++)
      words[i] = Math.imul(words[i]! ^ char.charCodeAt(0), 16777619 + i * 2) >>> 0;
  const hex = words.map((n) => n.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createConversation(
  companyId: string,
  phone: string,
  channel: Conversation['channel'],
  now: string,
): Conversation {
  return {
    id: idFor(`${companyId}:${phone}:${channel}:${now}`),
    companyId,
    customerPhone: phone,
    customerName: 'Guest',
    channel,
    language: 'en',
    mode: 'bot',
    messages: [],
    cart: emptyCart(),
    version: 0,
    updatedAt: now,
    lastInboundAt: now,
  };
}
// A chat that went to staff only because the bot was switched off goes back to the bot
// once it is on again. Any staff message since then means staff are handling it; an
// automatic order-status notice does not.
export function resumesAfterPause(conversation: Conversation): boolean {
  const pausedAt = conversation.botPausedAt;
  return (
    conversation.mode === 'human' &&
    !!pausedAt &&
    !conversation.messages.some((m) => m.role === 'staff' && !m.notice && m.createdAt >= pausedAt)
  );
}
// A chat paused by an AI limit goes back to the bot once that limit resets or is raised,
// again unless staff wrote since. Monthly $0 means "no AI", so it is never treated as raised.
type PausedChat = Pick<Conversation, 'mode' | 'limitPause' | 'messages'>;
export function limitPaused(conversation: PausedChat): boolean {
  const pause = conversation.limitPause;
  return (
    conversation.mode === 'human' &&
    !!pause &&
    !conversation.messages.some((m) => m.role === 'staff' && !m.notice && m.createdAt >= pause.at)
  );
}
export function resumesAfterLimit(
  conversation: PausedChat,
  company: Pick<Company, 'ai' | 'aiLimits'>,
  now = Date.now(),
): boolean {
  const pause = conversation.limitPause;
  if (!pause || !limitPaused(conversation)) return false;
  if (now >= Date.parse(pause.until)) return true;
  if (pause.reason === 'monthly') return company.ai.monthlyBudgetUsd > pause.limit;
  const limits = effectiveAiLimits(company.aiLimits);
  return (
    (pause.reason === 'hourly' ? limits.repliesPerHour : limits.repliesPerCustomerPerHour) >
    pause.limit
  );
}
// The language a built-in notice answers this message in, as the engine would reply.
export function noticeLanguage(company: Company, conversation: Conversation, text: string) {
  const configured = botConfig(company).language;
  return configured !== 'auto'
    ? configured
    : languageOf(customerWords(text), conversation.language);
}
// Orderly's own words in a customer's turn: a media, voice-note or unreadable-message marker,
// a shared location, and the keywords and button titles Orderly tells customers to use
// ("staff", "confirm", "review", "new order", "Confirm order").
const ORDERLY_MARKER = /^(?:customer sent a\b.*\bstaff assistance requested\.|location shared:)/isu;
const ORDERLY_KEYWORDS =
  /^(?:staff|human|insaan|insan|confirm|confirm order|talk to staff|review|new order|menu|cancel)[\s.!?؟]*$/iu;
/**
 * The words a customer typed, for telling their language: none for a button tap or Orderly's
 * own marker or keyword, so those never switch an Urdu or Roman Urdu chat to English. A
 * caption loses the "(sent with a photo)" marker.
 */
export function customerWords(text: string, action?: BotAction): string {
  const value = text.trim();
  if (action || ORDERLY_MARKER.test(value) || ORDERLY_KEYWORDS.test(value)) return '';
  return value.replace(/\s*\(sent with a (?:photo|video|document)\)$/u, '');
}
// What a customer is told when an AI limit pauses the bot. The same words for every limit:
// customers need to know a person will answer and whether their order is safe, not why.
export function limitNotice(lang: Language, cart: Cart): string {
  const base = say(
    lang,
    'Thanks for your message! Our team will reply here soon.',
    'آپ کے پیغام کا شکریہ! ہماری ٹیم جلد یہیں جواب دے گی۔',
    'Aap ke message ka shukriya! Hamari team jald yahin jawab degi.',
  );
  const order = orderSafetyLine(lang, cart);
  return order ? `${base} ${order}` : base;
}
// Whether the customer's order is safe, for any notice that hands the chat to staff: a placed
// order is not affected, an unplaced cart is not placed yet, and an empty cart needs no line.
// A submitted cart keeps its items, so the order is checked first.
export function orderSafetyLine(lang: Language, cart: Cart): string {
  return cart.orderId
    ? say(
        lang,
        'Your order is not affected.',
        'آپ کے آرڈر پر کوئی اثر نہیں پڑا۔',
        'Aap ke order par koi asar nahi para.',
      )
    : cart.items.length
      ? say(
          lang,
          'Your order hasn’t been placed yet.',
          'آپ کا آرڈر ابھی نہیں دیا گیا۔',
          'Aap ka order abhi place nahi hua.',
        )
      : '';
}
// What a customer is told when the AI model could not be reached.
export function aiErrorNotice(lang: Language, cart: Cart): string {
  const base = say(
    lang,
    'I’m having trouble connecting right now. A staff member will reply here soon.',
    'ابھی رابطے میں مسئلہ ہے۔ عملے کا ایک رکن جلد یہیں جواب دے گا۔',
    'Abhi connection mein masla hai. Staff ka koi member jald yahin jawab dega.',
  );
  const order = orderSafetyLine(lang, cart);
  return order ? `${base} ${order}` : base;
}
// The text, normalized, with every deal's name or its plural (longest first, as whole words)
// replaced by `by`, so a check never reads a deal's name as the customer's own words.
function withoutDealNames(products: Product[], text: string, by: string): string {
  return products
    .filter((product) => product.deal)
    .flatMap((product) => [product.name, ...product.aliases])
    .map((label) => normalize(label))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce(
      (rest, label) =>
        rest.replace(
          new RegExp(
            `(?<![\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![\\p{L}\\p{N}])`,
            'gu',
          ),
          by,
        ),
      normalize(text),
    );
}
// A deal's name is no request for a person: "2 Person Deal".
export const asksForPerson = (text: string, products: Product[] = []) =>
  /\b(human|staff|manager|person|insaan)\b|عملہ|انسان|مینیجر/u.test(
    withoutDealNames(products, text, ' '),
  );
// "do it" after "confirm" or "cancel", in the forms customers type: "kar do", "kar dein",
// "karein" (the bot's own "confirm karein"), "kren", "krden", "kijiye", "کریں", "کر دیجیے".
const DO_IT =
  'kar ?do|kar ?dein|kar ?dain|kar ?den|kar ?de|karo|karein|karain|karen|kariye|kariyega|krein|kren|kro|kr ?do|kr ?dein|kr ?dain|kr ?den|kar ?dijiye|kar ?dijiyega|kar ?dijye|kar ?dijie|kr ?dijiye|kijiye|kijiyega|kijie|kijye|kar ?lein|kar ?len|kr ?lein|kr ?len|کر دیں|کریں|کر دو|کرو|کردیں|کر دیجیے|کر دیجئے|کیجیے|کیجئے|کر لیں';
// A whole message asking to cancel the order: "Cancel.", "please cancel my order", "order cancel
// kar dein please", "آرڈر منسوخ کر دیں". A cancelled pending order cannot be restored, so only
// this closed set counts: "don't cancel", "cancel mat karo" or "cancel the raita" never do.
const CANCEL_REQUEST = new RegExp(
  [
    '^(?:(?:please|pls|plz|ji|bhai|sir|براہ کرم|پلیز|جی) )*',
    '(?:',
    'cancel(?: (?:my|the|this))?(?: order)?',
    '|(?:(?:my|the|this|mera|meri|mere) )?order cancel',
    '|(?:(?:میرا|یہ) )?(?:آرڈر )?(?:منسوخ|کینسل)',
    ')',
    `(?: (?:${DO_IT}))?`,
    '(?: (?:please|pls|plz|ji|bhai|sir|پلیز|جی))*$',
  ].join(''),
  'u',
);
// Quotes count as spacing: the reminder asks for “منسوخ”, and a copy keeps its quotes.
export const asksToCancelOrder = (text: string) =>
  CANCEL_REQUEST.test(
    normalize(text)
      .replace(/[.!?؟،۔,“”"‘’«»]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

function languageOf(text: string, previous: Language): Language {
  if (/[\u0600-\u06ff]/u.test(text)) return 'ur';
  if (
    /\b(mujhe|chahiye|chahye|karna|kardo|karen|mera|naam|haan|han|ji|nahi|kitna|bhej|wala|salam|salaam)\b/i.test(
      text,
    )
  )
    return 'roman-ur';
  return /[a-z]/i.test(text) ? 'en' : previous;
}
const say = (lang: Language, en: string, ur: string, roman: string) =>
  lang === 'ur' ? ur : lang === 'roman-ur' ? roman : en;
function invalidate(cart: Cart) {
  cart.revision += 1;
  unreview(cart);
}
// An empty cart in place of this one. The revision keeps increasing, so an earlier submission
// key is never reused.
function startNewCart(cart: Cart) {
  const revision = cart.revision + 1;
  Object.keys(cart).forEach((key) => delete (cart as unknown as Record<string, unknown>)[key]);
  Object.assign(cart, emptyCart(), { revision });
}
// Back to building without a cart change: nothing is confirmable until a review is shown again.
function unreview(cart: Cart) {
  cart.status = 'building';
  delete cart.reviewedRevision;
  delete cart.quoteHash;
  delete cart.quotedTotal;
  delete cart.reviewMessageId;
  delete cart.reviewedAt;
}

// Overnight hours count toward the day they start; deals use the same rule (shared/hours.ts).
export function isOpen(company: Company, now: string): boolean {
  try {
    const clock = localClock(company.timezone, now);
    return !!clock && inWindow(company.openingHours, clock);
  } catch {
    return false;
  }
}
// When a closed restaurant next opens: in how many days (0 = today), on which weekday.
function nextOpening(company: Company, now: string): { inDays: number; day: number } | undefined {
  try {
    const clock = localClock(company.timezone, now);
    const start = toMinute(company.openingHours.start);
    if (!clock || !Number.isFinite(start) || !Number.isFinite(toMinute(company.openingHours.end)))
      return undefined;
    for (let inDays = 0; inDays <= 7; inDays++) {
      const day = (clock.day + inDays) % 7;
      if (!company.openingHours.days.includes(day) || (inDays === 0 && clock.minute >= start))
        continue;
      return { inDays, day };
    }
  } catch {
    // Hours not set: no opening time to give.
  }
  return undefined;
}
export const orderIdFor = (submissionKey: string) => idFor(submissionKey);
/** The pending order a confirmed cart becomes. Chat and menu-page orders share it. */
export function buildOrder(
  company: Company,
  conversation: Pick<Conversation, 'id' | 'customerPhone' | 'channel'>,
  cart: Cart,
  quote: CartQuote,
  now: string,
  submissionKey: string,
  source?: 'menu_page',
): Order {
  const id = idFor(submissionKey);
  return {
    id,
    companyId: company.id,
    conversationId: conversation.id,
    reference: `ORD-${id.replaceAll('-', '').slice(-8).toUpperCase()}`,
    submissionKey,
    customerName: cart.customerName!,
    customerPhone: conversation.customerPhone,
    fulfillment: cart.fulfillment!,
    address: cart.fulfillment === 'delivery' ? cart.address : undefined,
    zone: cart.fulfillment === 'delivery' ? cart.zone : undefined,
    items: quote.items,
    subtotal: quote.subtotal,
    deliveryFee: quote.deliveryFee,
    total: quote.total,
    currency: 'PKR',
    status: 'pending',
    syncStatus: 'not_connected',
    createdAt: now,
    updatedAt: now,
    sandbox: conversation.channel === 'demo',
    phoneConfirmationRequired:
      !!company.bot?.published && botConfig(company).requirePhoneConfirmation,
    ...(source && { source }),
  };
}
const TRANSFER_NAMES: Record<Exclude<PaymentMethod, 'cash'>, [string, string, string]> = {
  jazzcash: ['JazzCash', 'جاز کیش', 'JazzCash'],
  easypaisa: ['Easypaisa', 'ایزی پیسہ', 'Easypaisa'],
  bank_transfer: ['bank transfer', 'بینک ٹرانسفر', 'bank transfer'],
};
// "a, b or c" in Urdu and Roman Urdu.
const orList = (names: string[], comma: string, or: string) =>
  names.length > 1 ? `${names.slice(0, -1).join(comma)} ${or} ${names.at(-1)}` : (names[0] ?? '');
// How a restaurant that also takes transfers is paid. Orderly never collects or sends account
// numbers. The customer is told how to get the restaurant's details: typing "staff" reaches a
// person in this chat, who sends them and confirms the transfer.
function transferPaymentText(
  lang: Language,
  fulfillment: Order['fulfillment'],
  methods: readonly PaymentMethod[],
): string {
  const cash = methods.includes('cash');
  const transfers = methods.filter((method) => method !== 'cash');
  const names = (index: 0 | 1 | 2) => transfers.map((method) => TRANSFER_NAMES[method][index]);
  return say(
    lang,
    `Payment: ${cash ? `cash ${fulfillment === 'pickup' ? 'at pickup' : 'on delivery'}, or ` : ''}${names(0).join(' / ')} — to pay by transfer, type “staff” here and restaurant staff will send the payment details and confirm the transfer themselves.`,
    `ادائیگی ${orList([...(cash ? ['نقد'] : []), ...names(1)], '، ', 'یا')} سے ${cash ? 'ہو سکتی ہے' : 'ہوگی'}۔ ٹرانسفر کے لیے ریسٹورنٹ کی ادائیگی کی تفصیل یہاں “عملہ” لکھ کر منگوائیں، عملہ ٹرانسفر کی تصدیق خود کرے گا۔`,
    `Payment ${orList([...(cash ? ['cash'] : []), ...names(2)], ', ', 'ya')} se ${cash ? 'ho sakti hai' : 'hogi'}. Transfer ke liye yahan “staff” likhein, restaurant ka staff payment details bhejega aur transfer khud confirm karega.`,
  );
}
/**
 * What the customer is told once their order is placed. `methods` are the restaurant's payment
 * methods (see paymentMethods); cash only, the default, keeps the wording orders always had.
 */
export function orderReceivedText(
  lang: Language,
  order: Order,
  methods: readonly PaymentMethod[] = ['cash'],
): string {
  const payment = methods.some((method) => method !== 'cash')
    ? transferPaymentText(lang, order.fulfillment, methods)
    : say(
        lang,
        `Payment is cash ${order.fulfillment === 'pickup' ? 'at pickup' : 'on delivery'}.`,
        'ادائیگی نقد ہوگی۔',
        'Payment cash hogi.',
      );
  let reply = `${say(
    lang,
    `Order ${order.reference} received — ${money(order.total)}. Awaiting restaurant acceptance.`,
    `آرڈر ${order.reference} موصول ہوا — ${money(order.total)}۔ ریسٹورنٹ کی منظوری کا انتظار ہے۔`,
    `Order ${order.reference} receive ho gaya — ${money(order.total)}. Restaurant ki manzoori ka intezar hai.`,
  )} ${payment}`;
  if (order.phoneConfirmationRequired)
    reply += say(
      lang,
      '\nRestaurant staff will call to confirm before accepting your order.',
      '\nعملہ آرڈر منظور کرنے سے پہلے فون پر تصدیق کرے گا۔',
      '\nRestaurant staff order accept karne se pehle call kar ke confirm karega.',
    );
  return reply;
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const URDU_WEEKDAYS = ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ'];
// The first words of closedText, which mark a reply that already said the restaurant is closed.
const CLOSED_LEADS = ['We are currently closed.', 'ہم اس وقت بند ہیں۔', 'Hum is waqt band hain.'];
// A closed restaurant's early notice is not repeated within this time.
const CLOSED_NOTICE_MS = 12 * 60 * 60 * 1000;
/**
 * What a customer is told while the restaurant is closed: its ordering hours and, given the
 * time now, when it opens again ("We open again tomorrow at 12:00.").
 */
export function closedText(company: Company, lang: Language, now?: string): string {
  const { start, end } = company.openingHours;
  const hours = say(
    lang,
    `We are currently closed. Ordering hours are ${start}–${end}.`,
    `ہم اس وقت بند ہیں۔ آرڈر کا وقت ${start}–${end} ہے۔`,
    `Hum is waqt band hain. Order ka waqt ${start}–${end} hai.`,
  );
  const opening = now ? nextOpening(company, now) : undefined;
  if (!opening) return hours;
  const { inDays, day } = opening;
  return `${hours} ${say(
    lang,
    `We open again ${inDays === 0 ? 'today' : inDays === 1 ? 'tomorrow' : `on ${WEEKDAYS[day]}`} at ${start}.`,
    `ہم ${inDays === 0 ? 'آج' : inDays === 1 ? 'کل' : `${URDU_WEEKDAYS[day]} کو`} ${start} بجے دوبارہ کھلیں گے۔`,
    `Hum ${inDays === 0 ? 'aaj' : inDays === 1 ? 'kal' : `${WEEKDAYS[day]} ko`} ${start} baje dobara khulenge.`,
  )}`;
}

const noChatOrdering = (lang: Language) =>
  say(
    lang,
    'Ordering in this chat is not available right now. Type “staff” to talk to a person.',
    'ابھی اس چیٹ میں آرڈر دستیاب نہیں ہے۔ کسی انسان سے بات کرنے کے لیے “عملہ” لکھیں۔',
    'Abhi is chat mein order available nahi hai. Kisi insaan se baat karne ke liye “staff” likhein.',
  );
// The engine's own refusal of a pickup/delivery choice the restaurant does not offer, in the
// customer's language. `change`: the cart already holds that choice, so they are asked to change it.
function fulfillmentRefusal(
  company: Company,
  chosen: 'pickup' | 'delivery',
  lang: Language,
  change = false,
): string | undefined {
  const offered = offeredFulfillment(company);
  if (offered === 'both' || offered === chosen) return undefined;
  if (!offered) return noChatOrdering(lang);
  return say(
    lang,
    `This restaurant currently offers ${offered} only.${change ? ` Please choose ${offered}.` : ''}`,
    offered === 'pickup'
      ? 'ابھی صرف پک اپ دستیاب ہے۔ براہ کرم پک اپ منتخب کریں۔'
      : 'ابھی صرف ڈیلیوری دستیاب ہے۔ براہ کرم ڈیلیوری منتخب کریں۔',
    `Abhi sirf ${offered} available hai. Meherbani karke ${offered} chunein.`,
  );
}
// Delivery areas a customer named that the restaurant does not deliver to.
const unknownZone = (company: Company, lang: Language) =>
  company.deliveryZones.length
    ? say(
        lang,
        `We deliver to: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
        `ہم ان علاقوں میں ڈیلیوری کرتے ہیں: ${company.deliveryZones.map((z) => z.name).join(', ')}۔`,
        `Hum in ilaqon mein delivery karte hain: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
      )
    : (fulfillmentRefusal(company, 'delivery', lang) ??
      say(
        lang,
        'We do not deliver right now.',
        'ابھی ہم ڈیلیوری نہیں کر رہے۔',
        'Abhi hum delivery nahi kar rahe.',
      ));

function missingDetails(company: Company, cart: Cart, lang: Language): string | undefined {
  if (!cart.items.length)
    return say(
      lang,
      'What would you like to order?',
      'آپ کیا آرڈر کرنا چاہیں گے؟',
      'Aap kya order karna chahenge?',
    );
  const offered = offeredFulfillment(company);
  if (!offered) return noChatOrdering(lang);
  if (cart.fulfillment && offered !== 'both' && cart.fulfillment !== offered)
    return say(
      lang,
      `We currently offer ${offered} only. Please choose ${offered}.`,
      offered === 'pickup'
        ? 'ابھی صرف پک اپ دستیاب ہے۔ براہ کرم پک اپ منتخب کریں۔'
        : 'ابھی صرف ڈیلیوری دستیاب ہے۔ براہ کرم ڈیلیوری منتخب کریں۔',
      `Abhi sirf ${offered} available hai. Meherbani karke ${offered} chunein.`,
    );
  if (!cart.fulfillment && offered === 'both')
    return say(
      lang,
      'Would you like pickup or delivery?',
      'آپ پک اپ کریں گے یا ڈیلیوری چاہیے؟',
      'Aap pickup karenge ya delivery chahiye?',
    );
  if (!cart.customerName?.trim())
    return say(
      lang,
      'What name should I put on the order?',
      'آرڈر کے لیے آپ کا نام کیا ہے؟',
      'Order ke liye aap ka naam kya hai?',
    );
  // The only option on offer is the customer's, without asking.
  const fulfillment = cart.fulfillment ?? offered;
  if (fulfillment === 'delivery' && !cart.zone)
    return say(
      lang,
      `Which delivery area? ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
      `ڈیلیوری کا علاقہ بتائیں: ${company.deliveryZones.map((z) => z.name).join('، ')}۔`,
      `Delivery ka ilaqa batayein: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
    );
  if (fulfillment === 'delivery' && !cart.address?.trim())
    return say(
      lang,
      'Please send your complete delivery address.',
      'مکمل ڈیلیوری پتہ لکھیں۔',
      'Mukammal delivery address bhejein.',
    );
}

/**
 * Read-only recap: missing checkout details must never hide the customer's cart. `problem` says
 * why a deal in it can't be ordered now (see dealProblem), in place of the general note.
 */
function cartSummary(
  company: Company,
  products: Product[],
  cart: Cart,
  lang: Language,
  problem?: string,
): string {
  if (!cart.items.length)
    return say(lang, 'Your cart is empty.', 'آپ کی ٹوکری خالی ہے۔', 'Aap ka cart khali hai.');
  const title = say(lang, 'Your order so far:', 'اب تک آپ کا آرڈر:', 'Ab tak aap ka order:');
  try {
    const quote = quoteCart(company, products, { ...cart, fulfillment: 'pickup' });
    const lines = quote.items.map(
      (item) =>
        `${item.quantity} × ${item.name}${item.variant ? ` (${item.variant})` : ''}${item.modifiers.length ? ` + ${item.modifiers.join(', ')}` : ''} — ${money(item.total)}${item.notes ? `\n  ${item.notes}` : ''}`,
    );
    lines.push(
      `${say(lang, 'Items subtotal', 'اشیاء کی رقم', 'Items subtotal')}: ${money(quote.subtotal)}`,
    );
    if (cart.fulfillment === 'delivery') {
      const zone = company.deliveryZones.find(
        (z) => normalize(z.name) === normalize(cart.zone ?? ''),
      );
      if (zone) {
        lines.push(
          `${say(lang, 'Delivery fee', 'ڈیلیوری فیس', 'Delivery fee')}: ${money(zone.fee)}`,
        );
        lines.push(`${say(lang, 'Total', 'کل رقم', 'Total')}: ${money(quote.subtotal + zone.fee)}`);
      } else
        lines.push(
          say(
            lang,
            'Delivery fee depends on your area.',
            'ڈیلیوری فیس علاقے کے مطابق ہوگی۔',
            'Delivery fee aap ke ilaqe ke mutabiq hogi.',
          ),
        );
    }
    return `${title}\n${lines.join('\n')}`;
  } catch {
    // Keep selections visible even if the catalog changed. Do not invent a price.
    return `${title}\n${cart.items
      .map((item) => {
        const product = products.find((p) => p.companyId === company.id && p.id === item.productId);
        const mark =
          product?.deal && product.deal.state !== 'on'
            ? say(lang, ' · not on now', ' · ابھی دستیاب نہیں', ' · abhi available nahi')
            : product && !product.available
              ? ' · Unavailable'
              : '';
        return `${item.quantity} × ${product?.name ?? 'Item no longer on the menu'}${mark}${item.notes ? `\n  ${item.notes}` : ''}`;
      })
      .join(
        '\n',
      )}\n\n${problem ?? say(lang, 'Some selections need checking against the current menu before a total can be confirmed.', 'کل رقم بتانے سے پہلے کچھ اشیاء موجودہ مینو سے چیک کرنا ضروری ہیں۔', 'Total batane se pehle kuch items current menu se check karne honge.')}`;
  }
}

// What a deal includes, for one line: "Zinger burger + Fries + 2 × Drink".
const includesText = (deal: NonNullable<Product['deal']>) =>
  deal.includes.map((line) => line.replace(/^1 × /u, '')).join(' + ');
// When a deal is on, in the chat's language ('' with no set times).
const dealTimes = (product: Product, lang: Language, clock?: Clock) =>
  product.deal?.schedule
    ? dealWhen(product.deal.schedule, lang, clock)
    : lang === 'en'
      ? (product.deal?.when ?? '')
      : '';
/**
 * Why a deal can't be added now, in the customer's language. Thrown, so no AI wording goes
 * with it.
 */
function dealRefusal(product: Product, lang: Language, clock?: Clock): string {
  const name = product.name;
  const when = dealTimes(product, lang, clock);
  const state = product.deal!.state;
  if (state === 'later' && when)
    return say(
      lang,
      `${name} is only available ${when}.`,
      `${name} صرف ${when} دستیاب ہے۔`,
      `${name} sirf ${when} available hai.`,
    );
  if (state === 'ended')
    return say(
      lang,
      `${name} has ended.`,
      `${name} ختم ہو چکی ہے۔`,
      `${name} khatam ho chuki hai.`,
    );
  if (state === 'sold_out')
    return say(
      lang,
      `${name} is sold out right now.`,
      `${name} کا سامان ابھی ختم ہے۔`,
      `${name} abhi sold out hai.`,
    );
  return say(
    lang,
    `${name} is not available right now.`,
    `${name} ابھی دستیاب نہیں ہے۔`,
    `${name} abhi available nahi hai.`,
  );
}
/**
 * A deal in the cart that isn't on now (its times are over, it sold out, was paused or ended),
 * with how to take it out, in the customer's language; undefined when every deal in it is on.
 * Checked before the whole cart is priced, so a stale deal is named instead of blocking the
 * cart with a general error.
 */
function dealProblem(
  company: Company,
  products: Product[],
  cart: Cart,
  lang: Language,
  clock?: Clock,
): string | undefined {
  for (const item of cart.items) {
    const product = products.find((p) => p.companyId === company.id && p.id === item.productId);
    if (!product?.deal || product.deal.state === 'on') continue;
    const name = product.name;
    const when = dealTimes(product, lang, clock);
    const state = product.deal.state;
    const why =
      state === 'later' && when
        ? say(
            lang,
            `${name} in your cart is only available ${when}.`,
            `آپ کی ٹوکری میں ${name} صرف ${when} دستیاب ہے۔`,
            `Aap ke cart mein ${name} sirf ${when} available hai.`,
          )
        : state === 'ended'
          ? say(
              lang,
              `${name} in your cart has ended.`,
              `آپ کی ٹوکری میں ${name} ختم ہو چکی ہے۔`,
              `Aap ke cart mein ${name} khatam ho chuki hai.`,
            )
          : state === 'sold_out'
            ? say(
                lang,
                `${name} in your cart is sold out right now.`,
                `آپ کی ٹوکری میں ${name} کا سامان ابھی ختم ہے۔`,
                `Aap ke cart mein ${name} abhi sold out hai.`,
              )
            : say(
                lang,
                `${name} in your cart is not available right now.`,
                `آپ کی ٹوکری میں ${name} ابھی دستیاب نہیں ہے۔`,
                `Aap ke cart mein ${name} abhi available nahi hai.`,
              );
    return `${why} ${say(
      lang,
      `Send “remove ${name}” to take it out, then carry on.`,
      `اسے نکالنے کے لیے “remove ${name}” لکھیں، پھر آرڈر جاری رکھیں۔`,
      `Isay nikalne ke liye “remove ${name}” likhein, phir order jari rakhein.`,
    )}`;
  }
  return undefined;
}
// The deal's first choice with none of these picks.
const openChoice = (product: Product, picked: string[]) =>
  product.deal?.choices.find((choice) => !choice.options.some((o) => picked.includes(o.id)));
// Said when other deals in the message were not added, to ask for them.
const nextDealNote = (lang: Language) =>
  say(lang, 'Then tell me the next deal.', 'پھر اگلی ڈیل بتائیں۔', 'Phir agli deal batayein.');
// The deal's choice still to make, as the engine asks it: "Choose Drink for Deal 1:\n1. Coke
// …\n3. Fanta (+Rs. 50)", or '' with none left. It keeps the list shown in `pending`, so a number
// answers what the customer saw. `more`: another deal in the message waits for its turn.
function dealChoiceQuestion(
  product: Product,
  pending: NonNullable<Conversation['pendingDealChoice']>,
  lang: Language,
  more = false,
): string {
  const group = openChoice(product, pending.picked);
  if (!group) return '';
  pending.groupId = group.id;
  pending.optionIds = group.options.map((option) => option.id);
  const deal = pending.quantity > 1 ? `${pending.quantity} × ${product.name}` : product.name;
  return `${say(lang, `Choose ${group.name} for ${deal}:`, `${deal} کے لیے ${group.name} منتخب کریں:`, `${deal} ke liye ${group.name} chunein:`)}\n${group.options
    .map(
      (option, index) =>
        `${index + 1}. ${option.name}${option.price > 0 ? ` (+${money(option.price)})` : ''}`,
    )
    .join('\n')}${more ? `\n\n${nextDealNote(lang)}` : ''}`;
}

export function isCartSummaryRequest(text: string): boolean {
  const value = normalize(text);
  return /\b(?:repeat|recap|summari[sz]e|show|read(?: back)?)\b.*\b(?:order|cart|selections)\b|\bwhat (?:have i|did i|i have) (?:ordered|order)|\b(?:mera|meri) (?:order|cart).*\b(?:batao|bataye|dikhao|dohrao)|(?:میرا|میرے)\s*آرڈر.*(?:بتا|دکھا|دہرا)/u.test(
    value,
  );
}

// While closed, the review shows the order but is not confirmable: the cart stays 'building', so
// no Confirm button is attached and a later "confirm" gets a fresh review. `includes`: false
// leaves out what deals include.
function review(
  company: Company,
  products: Product[],
  cart: Cart,
  lang: Language,
  now: string,
  includes = true,
): string {
  const missing = missingDetails(company, cart, lang);
  if (missing) return `${cartSummary(company, products, cart, lang)}\n\n${missing}`;
  const open = isOpen(company, now);
  const quote = quoteCart(company, products, cart);
  // Under a deal, what it includes ("   Zinger burger + Fries + Drink").
  const lines = (includes: boolean) =>
    quote.items
      .map(
        (item) =>
          `${item.quantity} × ${item.name}${item.variant ? ` (${item.variant})` : ''}${item.modifiers.length ? ` + ${item.modifiers.join(', ')}` : ''} — ${money(item.total)}${includes && item.includes?.length ? `\n   ${item.includes.map((line) => line.replace(/^1 × /u, '')).join(' + ')}` : ''}${item.notes ? `\n  ${item.notes}` : ''}`,
      )
      .join('\n');
  const reviewText = (includes: boolean) =>
    [
      say(
        lang,
        'Please review your order:',
        'اپنے آرڈر کا جائزہ لیں:',
        'Apna order check kar lein:',
      ),
      lines(includes),
      `\n${cart.fulfillment === 'delivery' ? `Delivery: ${cart.address} (${cart.zone})` : 'Pickup'} · ${cart.customerName}`,
      `${say(lang, 'Delivery fee', 'ڈیلیوری فیس', 'Delivery fee')}: ${money(quote.deliveryFee)}`,
      `${say(lang, 'Total', 'کل رقم', 'Total')}: ${money(quote.total)}`,
      open
        ? say(
            lang,
            '\nReply “confirm” to submit this order for restaurant acceptance.',
            '\nریسٹورنٹ کی منظوری کے لیے آرڈر بھیجنے کو “تصدیق” لکھیں۔',
            '\nRestaurant ki manzoori ke liye “confirm” ya “haan” likhein.',
          )
        : `\n${closedText(company, lang, now)}${say(
            lang,
            ' Your cart is saved. Send “review” when we are open.',
            ' آپ کی ٹوکری محفوظ ہے۔ ہمارے کھلنے پر “جائزہ” لکھیں۔',
            ' Cart save hai. Jab hum khule hon to “review” likhein.',
          )}`,
    ].join('\n');
  // WhatsApp drops the review's buttons above 1024 characters, so what deals include is shown
  // only while the review stays within that (and the whole reply does: see finish()).
  const withIncludes =
    includes && quote.items.some((item) => item.includes?.length) ? reviewText(true) : '';
  const text = withIncludes && withIncludes.length <= 1024 ? withIncludes : reviewText(false);
  if (text.length > 3500)
    throw new Error('This order is too large for one message. Please ask staff to complete it.');
  if (!open) {
    unreview(cart);
    return text;
  }
  cart.status = 'awaiting_confirmation';
  cart.reviewedRevision = cart.revision;
  cart.quoteHash = quote.hash;
  cart.quotedTotal = quote.total;
  return text;
}

// Words that do not name a dish. The AI sometimes passes the customer's own words
// ("menu", "rates", "biryani rates") as the search, so they are left out of the match.
const NOT_DISH_WORDS = new Set([
  'menu',
  'menus',
  'full',
  'whole',
  'complete',
  'all',
  'everything',
  'item',
  'items',
  'food',
  'foods',
  'dish',
  'dishes',
  'rate',
  'rates',
  'price',
  'prices',
  'pricing',
  'list',
  'card',
  'the',
  'your',
  'our',
  'a',
  'an',
  'any',
  'some',
  'of',
  'for',
  'do',
  'you',
  'have',
  'is',
  'are',
  'what',
  'which',
  'show',
  'send',
  'me',
  'please',
  'pls',
  'mainu',
  'khana',
  'kya',
  'hai',
  'ka',
  'ki',
  'ke',
  'bhej',
  'dikhao',
  'and',
  'with',
  'batao',
  'btao',
  'bataen',
  'batayein',
  'bhejo',
  'bhejein',
  'hain',
  'kitna',
  'kitne',
  'kitni',
  'chahiye',
  'karo',
  'aur',
  'مینو',
  'ریٹ',
  'قیمت',
  'قیمتیں',
  'کی',
  'کا',
  'کے',
  'کیا',
  'ہے',
  'ہیں',
  'میں',
  'بتائیں',
  'بتاؤ',
  'بھیجیں',
]);
const dishWords = (query?: string) =>
  query
    ? normalize(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word && !NOT_DISH_WORDS.has(word))
    : [];

// A menu search for the deals themselves: "deals", "koi deal", "today's offers", "ڈیلز".
const DEAL_QUERY = /^(?:deals?|combos?|offers?|ڈیل|ڈیلز|ڈیلیں)$/u;
const DEAL_QUERY_FILLER = new Set([
  'koi',
  'kuch',
  'aaj',
  'today',
  'todays',
  'current',
  'running',
  'special',
  'specials',
  'latest',
  'new',
  'available',
  'chal',
  'rahi',
  'rahe',
  'kon',
  'kaun',
  'konsi',
  'kaunsi',
  'si',
  'sa',
  'کوئی',
  'کچھ',
  'آج',
]);
// A one-letter word is shorthand ("koi deal h?"); a digit names a deal ("deal 1").
const asksForDeals = (words: string[]) =>
  words.some((word) => DEAL_QUERY.test(word)) &&
  words.every(
    (word) =>
      DEAL_QUERY.test(word) ||
      DEAL_QUERY_FILLER.has(word) ||
      (word.length === 1 && !/\p{N}/u.test(word)),
  );
// A line of the chat menu cut to `max` characters, so one long deal never fills the message.
const clip = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

function menu(
  company: Company,
  products: Product[],
  lang: Language,
  query?: string,
  guided = false,
  link?: string,
  now?: string,
): string {
  const all = products.filter((p) => p.companyId === company.id);
  if (!all.length)
    return say(
      lang,
      'Our menu is not available right now. Type “staff” to talk to a person.',
      'ابھی مینو دستیاب نہیں ہے۔ کسی انسان سے بات کرنے کے لیے “عملہ” لکھیں۔',
      'Abhi menu available nahi hai. Kisi insaan se baat karne ke liye “staff” likhein.',
    );
  // Paused and ended deals are on the bot's list only so they can be refused by name.
  const hasDeals = all.some((p) => p.deal);
  const listed = hasDeals
    ? all.filter((p) => !p.deal || (p.deal.state !== 'paused' && p.deal.state !== 'ended'))
    : all;
  const clock = hasDeals && now ? localClock(company.timezone, now) : undefined;
  // A deal: price and saving, then what it includes and its choices; when it is on if not now.
  const dealEntry = (p: Product) => {
    const deal = p.deal!;
    const saving = dealSavings(p);
    const when = deal.state === 'later' ? dealTimes(p, lang, clock) : '';
    return `${p.emoji} ${p.name} — ${money(p.price)}${saving ? say(lang, ` (save ${money(saving)})`, ` (${money(saving)} کی بچت)`, ` (${money(saving)} ki bachat)`) : ''}${
      when
        ? say(lang, ` · On ${when}`, ` · ${when} دستیاب`, ` · ${when} available`)
        : deal.state === 'on'
          ? ''
          : ' · Unavailable'
    }${deal.includes.length ? `\n  ${clip(includesText(deal), 300)}` : ''}${deal.choices
      .map(
        (group) =>
          `\n  ${clip(
            `${group.name}: ${group.options
              .slice(0, 8)
              .map(
                (option) => `${option.name}${option.price > 0 ? ` (+${money(option.price)})` : ''}`,
              )
              .join(', ')}${group.options.length > 8 ? ', …' : ''}`,
            200,
          )}`,
      )
      .join('')}`;
  };
  const words = dishWords(query);
  // One deal asked about by its name ("deal 9 kitne ki hai?") is shown alone, with anything else
  // of that very name; "deal 9" is not every deal.
  const asked = [normalizeCatalogText(query ?? ''), words.join(' ')].filter(Boolean);
  const byName = hasDeals
    ? listed.filter((p) =>
        [p.name, ...p.aliases].some((label) => asked.includes(normalizeCatalogText(label))),
      )
    : [];
  if (byName.some((p) => p.deal))
    return menuText(
      company,
      lang,
      byName,
      (p) => (p.deal ? dealEntry(p) : menuLine(p)),
      guided,
      link,
    );
  if (hasDeals && asksForDeals(words)) {
    // On and later deals (sold out ones marked), then the menu's own "Deals" section.
    const deals = listed.filter((p) => p.deal);
    if (!deals.some((p) => p.deal!.state === 'on' || p.deal!.state === 'later'))
      return `${say(lang, 'We have no deals on right now.', 'ابھی کوئی ڈیل نہیں چل رہی۔', 'Abhi koi deal nahi chal rahi.')}\n\n${menu(company, products, lang, undefined, guided, link, now)}`;
    return menuText(
      company,
      lang,
      [...deals, ...listed.filter((p) => !p.deal && /^deals?$/i.test(p.category.trim()))],
      (p) => (p.deal ? dealEntry(p) : menuLine(p)),
      guided,
      link,
    );
  }
  const textOf = (p: Product) => normalize(`${p.name} ${p.category} ${p.aliases.join(' ')}`);
  const matchingAll = (list: string[]) =>
    listed.filter((p) => list.every((word) => textOf(p).includes(word)));
  // Prefer dishes matching every word; otherwise ignore words that match no dish at all
  // (an unlisted filler word must not hide a dish that is on the menu).
  const known = words.filter((word) => listed.some((p) => textOf(p).includes(word)));
  const matching = !words.length
    ? listed
    : matchingAll(words).length
      ? matchingAll(words)
      : known.length
        ? matchingAll(known)
        : [];
  // Never answer a menu request with an empty list: show the menu instead.
  const own = matching.length ? matching : listed;
  // Quote only letters and digits, cut by character, and never the AI's text when it
  // reads like a price or an order outcome: only the engine states those.
  const shown = Array.from(words.join(' ')).slice(0, 40).join('');
  const notFound =
    words.length && !matching.length
      ? `${
          query && unsafeModelText(query)
            ? say(
                lang,
                'We couldn’t find that on the menu. Here is our menu:',
                'یہ چیز مینو میں نہیں ملی۔ یہ رہا ہمارا مینو:',
                'Yeh cheez menu mein nahi mili. Yeh raha hamara menu:',
              )
            : say(
                lang,
                `We couldn’t find “${shown}” on the menu. Here is our menu:`,
                `“${shown}” مینو میں نہیں ملا۔ یہ رہا ہمارا مینو:`,
                `“${shown}” menu mein nahi mila. Yeh raha hamara menu:`,
              )
        }\n\n`
      : '';
  if (!hasDeals || own !== listed)
    return menuText(
      company,
      lang,
      own,
      (p) => (p.deal ? dealEntry(p) : menuLine(p)),
      guided,
      link,
      notFound,
    );
  // The whole menu: up to 3 deals that are on, one line each, then the dishes.
  const deals = listed.filter((p) => p.deal && p.deal.state !== 'sold_out');
  const on = deals.filter((p) => p.deal!.state === 'on').slice(0, 3);
  const top = on.map(
    (p) =>
      `${p.emoji} ${p.name} — ${money(p.price)}${p.deal!.includes.length ? `: ${clip(includesText(p.deal!), 200)}` : ''}`,
  );
  const more = deals.length - on.length;
  // With none on now, the others run at other times: no "…and N more" under nothing.
  if (more > 0)
    top.push(
      on.length
        ? say(
            lang,
            `…and ${more} more deal${more === 1 ? '' : 's'}. Send “deals” to see them all.`,
            `…اور ${more} مزید ڈیلز۔ سب دیکھنے کے لیے “deals” لکھیں۔`,
            `…aur ${more} deals hain. Sab dekhne ke liye “deals” likhein.`,
          )
        : say(
            lang,
            `We have ${more} deal${more === 1 ? '' : 's'} at other times. Send “deals” to see ${more === 1 ? 'it' : 'them'}.`,
            `دوسرے اوقات میں ${more} ڈیلز دستیاب ہیں۔ دیکھنے کے لیے “deals” لکھیں۔`,
            `Doosre waqt par ${more} deals available hain. Dekhne ke liye “deals” likhein.`,
          ),
    );
  return menuText(
    company,
    lang,
    listed.filter((p) => !p.deal),
    menuLine,
    guided,
    link,
    notFound,
    top,
  );
}
// A dish on the chat menu: price, sizes and extras.
const menuLine = (p: Product) =>
  `${p.emoji} ${p.name} — ${money(p.price)}${p.available ? '' : ' · Unavailable'}${
    p.variants.length
      ? `\n  ${p.variants
          .slice(0, 4)
          .map((v) => `${v.name.slice(0, 60)} ${money(v.price)}`)
          .join(' / ')}${p.variants.length > 4 ? ' / more options available' : ''}`
      : ''
  }${
    p.modifiers.length
      ? `\n  Extras: ${p.modifiers
          .slice(0, 4)
          .map((m) => `${m.name.slice(0, 60)} +${money(m.price)}`)
          .join(', ')}${p.modifiers.length > 4 ? ' / more extras available' : ''}`
      : ''
  }`;
// The chat menu: at most 12 entries and 2800 characters, with any `top` lines (deals) first.
function menuText(
  company: Company,
  lang: Language,
  entries: Product[],
  entryText: (p: Product) => string,
  guided: boolean,
  link?: string,
  notFound = '',
  top: string[] = [],
): string {
  const lines = [...top];
  let shown = 0;
  for (const p of entries) {
    const line = entryText(p);
    if (lines.join('\n').length + line.length > 2800 || lines.length >= 12) break;
    lines.push(line);
    shown += 1;
  }
  const linkLine = link ? `\n\n${menuLinkLine(lang, link)}` : '';
  return `${notFound}${company.name}\n${lines.join('\n')}${shown < entries.length ? `\n\nShowing ${shown} of ${entries.length} items. Ask for a category or item name to narrow the menu.` : ''}${guided ? '' : `\n\n${say(lang, 'Tell me the item and quantity, for example “2 chicken biryani”.', 'چیز کا نام اور تعداد بتائیں، جیسے “2 چکن بریانی”۔', 'Item aur quantity batayein, jaise “2 chicken biryani”.')}`}${linkLine}`;
}
const menuLinkLine = (lang: Language, link: string) =>
  say(
    lang,
    `See the full menu and order here: ${link}`,
    `پورا مینو دیکھیں اور یہاں آرڈر کریں: ${link}`,
    `Poora menu dekhein aur yahan order karein: ${link}`,
  );
// A whole message asking for the menu ("menu", "send the full menu", "menu bhej dein", "مینو").
// The bot may answer it with sections or a question instead of the engine's menu, so the
// menu page link is added under whatever it replied.
const MENU_REQUEST =
  /^(?:(?:hi|hello|salam|aoa|bhai|sir|ji|please|pls|plz|zara|mujhe|ذرا|مجھے|براہ کرم|پلیز)[,،]? ){0,2}(?:(?:(?:can|could|may|would) (?:i|we|you) (?:please )?(?:see|have|get|send|share|show|give)(?: me| us)?|i (?:want|need|would like)(?: to see| to have)?|(?:send|share|show|give)(?: me| us)?) (?:the |your |ur )?(?:full |whole |complete )?menu(?: card| list| link)?(?: again)?|(?:the |your )?(?:full |whole |complete )?menu(?: card| list| link| again)?|(?:(?:pura|poora|pora) )?menu(?: ka)?(?: link)? (?:bhejo|bhej ?do|bhej (?:dein|den|dain|dijiye|dijye)|bhej(?:ein|en|ain|iye)|send (?:karo|kardo|kar do|kar dein|karein|kro|krdo|kr do)|dikhao|dikha ?do|dikha (?:dein|den|dain)|dikha(?:yein|yen|en|ain|iye|ein)|chahiye|chaiye|chahye|chahie|de (?:do|dein|den|dain)|dein|batao|batayein|bata do)|(?:pura|poora|pora) menu|(?:پورا )?(?:مینو|مینیو|مينو|مينيو)(?: کارڈ| کا لنک)?(?: بھیجیں| بھیجو| بھیج دیں| بھیج دو| بھیج دیجیے| بھیج دیجئے| بھجیں| دکھائیں| دکھاؤ| دکھا دیں| دکھا دو| چاہیے| چاہئے| دیں| دے دیں| دے دو| بتائیں| ارسال کریں)?)(?: please| pls| plz| plez| pleas+e*| پلیز)?[.!?؟،۔\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]*$/u;
export const asksForMenu = (text: string) => MENU_REQUEST.test(normalize(text));
// The exact link, not a longer address that starts with it, so it is personalised when sent.
const hasMenuLink = (text: string, link: string) =>
  text
    .split(link)
    .slice(1)
    .some((after) => !/^[A-Za-z0-9/#?-]/.test(after));

// The menu page link in owner or AI wording (greeting, answers, rules). Without a link the
// placeholder is left out with a separator just before it ("Menu: {menu_link}" becomes
// "Menu"), and a line left with no words is dropped.
const MENU_LINK_GAP = /\s*(?:[:：=|>\-–—→➡👉]\u{FE0F}?\s*)*\{menu_link\}/gu;
// A placeholder that starts a line (after any list marker, which stays) takes the separators
// after it too ("{menu_link} - order", "• {menu_link} ⬅️ tap").
const MENU_LINK_LEAD =
  /^(\s*(?:[•·*]|\d+[.)])\s+)?\s*(?:[:：=|>\-–—→➡👉]\u{FE0F}?\s*)*\{menu_link\}\s*(?:[:：=|>\-–—→➡←⬅👈]\u{FE0F}?\s*)*/u;
export function fillMenuLink(text: string, link?: string): string {
  if (!text.includes('{menu_link}')) return text;
  if (link) return text.replaceAll('{menu_link}', link);
  return text
    .split('\n')
    .flatMap((line) => {
      if (!line.includes('{menu_link}')) return [line];
      const left = line
        .replace(MENU_LINK_LEAD, '$1')
        .replace(MENU_LINK_GAP, '')
        .replace(/\s*(?:\(\s*\)|\[\s*\])/g, '')
        .trim();
      return /[\p{L}\p{N}]/u.test(left) ? [left] : [];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Web links in AI wording. Addresses with a scheme, "www." or wa.me are always checked; a bare
// domain only with a common ending in lower case, so "ready.in 20", "Rs.500" or a missing
// space after a full stop ("available.Online") never count as links.
const EXPLICIT_LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+|\bwa\.me\/\S*/giu;
const BARE_DOMAIN =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|pk|io|app|dev|page|ly|link|site|online|store|shop|xyz|info|biz)\b(?:\/\S*)?/giu;
const BARE_ENDING =
  /\.(?:com|net|org|pk|io|app|dev|page|ly|link|site|online|store|shop|xyz|info|biz)$/u;
// Endings that are also words: "Lahore.info about…" is a missing space, not a link.
const WORD_ENDING = /\.(?:app|page|link|site|online|store|shop|info)$/u;
function linkHost(link: string): string {
  return (link.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? '')
    .replace(/^.*@/, '')
    .replace(/:\d*$/, '')
    .replace(/[.,;:!?)\]}'"’”۔،]+$/u, '')
    .toLowerCase()
    .replace(/^www\./, '');
}
function linksIn(text: string): string[] {
  const bare = [...text.matchAll(BARE_DOMAIN)]
    .map((m) => m[0])
    .filter((m) => {
      const host = m.split(/[/?#]/)[0] ?? '';
      if (!BARE_ENDING.test(host)) return false;
      return !(WORD_ENDING.test(host) && !m.includes('/') && /[A-Z]/.test(host));
    });
  return [...[...text.matchAll(EXPLICIT_LINK)].map((m) => m[0]), ...bare];
}
// Allowed hosts are read loosely: everything detection finds, plus any ending in any case, an
// email's domain, "linktr.ee/x" or "m.me/x". Allowing too much here only ever keeps a reply.
const ANY_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b/giu;
const hostsIn = (text: string) =>
  [...linksIn(text), ...[...text.matchAll(ANY_HOST)].map((m) => m[0])].map(linkHost);
/**
 * Web hosts the owner gave (business details, answers, bot settings) plus the app's own, and
 * any other text whose hosts the AI may repeat (the customer's messages, the menu).
 */
export function linkAllowlist(
  company: Company,
  configuration: BotConfig,
  appHost?: string,
  more: (string | undefined)[] = [],
): Set<string> {
  const sources = [
    company.name,
    company.address,
    ...company.faqs.flatMap((faq) => [faq.question, faq.answer]),
    configuration.goal,
    configuration.instructions,
    configuration.greeting,
    configuration.handoffMessage,
    ...configuration.behaviorRules.map((rule) => rule.response),
    ...more,
  ];
  const hosts = new Set(sources.flatMap((text) => hostsIn(text ?? '')));
  if (appHost) hosts.add(appHost.toLowerCase().replace(/^www\./, ''));
  hosts.delete('');
  return hosts;
}
/**
 * Whether the text links to a website the owner never gave (matched by host). `hosts` may be
 * built lazily, since most texts have no link at all; `alsoAllowed` admits other hosts.
 */
export function inventsLink(
  text: string,
  hosts: Set<string> | (() => Set<string>),
  alsoAllowed?: (host: string) => boolean,
): boolean {
  return linksIn(text).some((link) => {
    const host = linkHost(link);
    if (!host) return true;
    if (alsoAllowed?.(host)) return false;
    const allowed = typeof hosts === 'function' ? hosts() : hosts;
    return ![...allowed].some((known) => host === known || host.endsWith(`.${known}`));
  });
}

// Consent to place a reviewed order, read from the whole message. Explicit wording ("Yes,
// confirm", "confirm kar dein ✅", "place order", "جی کنفرم") counts against the latest review; a
// bare "yes", "ok", "haan" or "ٹھیک ہے" only straight after the review itself, since it may
// answer any question. A question, a negation or any other word (an item, a detail) is never
// consent: "confirm?", "confirm nahi", "yes, add raita", "2 more naan, confirm".
const YES_WORDS =
  'yes|yess+|yeah|yep|yup|ok|okay|okey|okk+|sure|haan|han|haan ji|han ji|ji haan|ji han|ji|jee|g|theek hai|thik hai|theek|thik|bilkul|جی|ہاں|جی ہاں|ہاں جی|ٹھیک ہے|ٹھیک|اوکے';
const FILLERS = 'please|pls|plz|ji|jee|g|bhai|sir|پلیز|جی';
const EXPLICIT_CONSENT = new RegExp(
  `^(?:(?:${YES_WORDS}|${FILLERS}|abhi) ){0,3}(?:confirm(?:ed)?(?: (?:my |the |this )?order| it)?|order confirm(?:ed)?|(?:place|submit) (?:my |the |this )?order|order place|submit|tasdeeq|کنفرم|تصدیق|آرڈر کنفرم|آرڈر کی تصدیق)(?: (?:${DO_IT}))?(?: (?:${FILLERS}|now))*$`,
  'u',
);
const BARE_CONSENT = new RegExp(
  `^(?:(?:${FILLERS}) )?(?:${YES_WORDS}|order kar ?do|order kar ?dein|order kar ?dain|آرڈر کر دیں)(?: (?:${FILLERS}|hai))*$`,
  'u',
);
// ✅ ✔ ☑ 👍 👌 🙏 with skin tones and joiners. Any other emoji leaves a word that is not consent.
const POSITIVE_MARK =
  '[\\u2705\\u2714\\u2611\\u{1F44D}\\u{1F44C}\\u{1F64F}\\u{1F3FB}-\\u{1F3FF}\\uFE0F\\u200D]';
function consent(text: string): 'explicit' | 'bare' | undefined {
  const value = normalize(text);
  if (
    /[?؟❌✖\u{1F6AB}\u{1F44E}]|نہیں|مت(?:\s|$)/u.test(value) ||
    /\b(?:no|not|nahi|nahin|nai|nhi|mat|dont|don['’]t|never|cancel)\b/u.test(value)
  )
    return undefined;
  const words = value
    .replace(new RegExp(POSITIVE_MARK, 'gu'), ' ')
    .replace(/[.!,،۔]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (EXPLICIT_CONSENT.test(words)) return 'explicit';
  if (BARE_CONSENT.test(words) || (!words && new RegExp(POSITIVE_MARK, 'u').test(value)))
    return 'bare';
  return undefined;
}
// The message a customer is answering: the one before theirs. parseActions also runs before the
// message is saved (for the AI's hint), so a trailing copy of this very text is skipped.
function answeredMessage(conversation: Conversation, text: string) {
  const last = conversation.messages.at(-1);
  return last?.role === 'customer' && last.text === text.slice(0, 4000)
    ? conversation.messages.at(-2)
    : last;
}
// Whether that message is the review this cart awaits confirmation against, and it was delivered.
const isLatestReview = (cart: Cart, message?: Conversation['messages'][number]) =>
  cart.status === 'awaiting_confirmation' &&
  !!cart.reviewMessageId &&
  message?.role === 'assistant' &&
  message.id === cart.reviewMessageId &&
  message.delivery !== 'failed';
// A review older than this is shown again before an order is placed from it.
const REVIEW_FRESH_MS = 60 * 60 * 1000;
function contains(text: string, phrase: string): boolean {
  const p = normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${p}(?=$|[^\\p{L}\\p{N}])`, 'u').test(normalize(text));
}
// AI wording that states a price or an order outcome: only the engine words those. Outcomes in
// Roman Urdu, Urdu and English are tied to the order (or payment) as their subject, so "aap ka
// naam save ho gaya hai" or "ہم کل ۱۲ بجے کھلیں گے" (کل is also tomorrow) pass. Prices need a
// currency next to the digits ("450/-", "450 rupay", "۴۵۰ روپے", "500 PKR"). After an order is
// submitted, saying it was placed, submitted or received is true, so those claims are allowed
// then; confirmed, booked, accepted or delivered never are, nor a payment received, nor more
// ordered or added. A polite request ("کنفرم کر دیں", "تصدیق کر دیجیے", "confirm kar di jiye")
// or the future ("deliver kar diya jayega", "کر دیا جائے گا") is not a claim.
const NOT_DONE =
  '(?!\\s*(?:jiye|jiyega|jiyen|jie|jiey|jye|jiay|jayega|jayegi|jayenge|jaye|jaega|jaegi|jaenge)\\b)';
const outcomeClaim = (verbs: string) =>
  new RegExp(
    `\\b(?:order|payment|adaigi)\\b[^.!?\\n]{0,30}?\\b(?:${verbs})\\w*\\s*(?:ho|hu|kar|kr)\\s*(?:gaya|gayi|gya|gyi|gai|gaye|ge|diya|diye|dia|di|liya|liye|lia|li|chuka|chuki|chuke)\\b${NOT_DONE}`,
    'u',
  );
const ROMAN_OUTCOME = outcomeClaim('confirm|book|accept|approve|deliver|dispatch|rawana|complete');
const ROMAN_PLACED = outcomeClaim('place|submit|receive');
// Past forms only: "کر دیا", "ہو گیا", not "کر دیں", "کر دیجیے", "کر لیں" or "کر دیا جائے گا".
const URDU_DONE =
  '(?:ہو|کر)\\s?(?:گیا|گئی|گئے|دیا|دی|دیے|لیا|لی|چکا|چکی|چکے)(?![\\p{L}\\p{M}])(?!\\s?(?:جائے|جاۓ|جائیں|جائےگا))';
const URDU_OUTCOME = new RegExp(
  `(?:آرڈر|ادائیگی)[^۔.!?؟\\n]{0,30}?(?:کنفرم|بک|منظور|روانہ|تصدیق|ڈیلیور|قبول)[^۔.!?؟\\n]{0,10}?${URDU_DONE}`,
  'u',
);
const URDU_PLACED = new RegExp(
  `(?:آرڈر|ادائیگی)[^۔.!?؟\\n]{0,30}?(?:موصول|وصول|پلیس|سبمٹ)[^۔.!?؟\\n]{0,10}?${URDU_DONE}`,
  'u',
);
const ENGLISH_STATUS =
  /\b(?:order|payment)\b[^.!?\n]{0,30}?\b(?:on (?:its|the) way|being prepared|out for delivery)\b/u;
const ENGLISH_RECEIVED = /\b(?:order|payment)\b[^.!?\n]{0,30}?\breceived\b/u;
const ENGLISH_PRICE =
  /\b(?:rs\.?|pkr)\s*[\d۰-۹٠-٩]|\b(?:total|price|cost)\s*(?:(?:is|of|:|=)\s*)?[\d۰-۹٠-٩]/iu;
const ENGLISH_OUTCOME = /\b(?:accepted|approved|confirmed|delivered|dispatched|completed)\b/iu;
const ENGLISH_PLACED = /\b(?:submitted|placed)\b/iu;
// After submission, "your order has been placed" or "yes, it was submitted" is true; placing or
// adding more never is.
const ORDER_PLACED =
  /\border\b[^.!?\n]{0,30}?\b(?:placed|submitted)\b|\b(?:placed|submitted)\s+(?:your|the)\s+order\b|\bit(?:['’]s| is| was| has)?(?: been)? (?:placed|submitted)\b/u;
const DONE_FORMS =
  '(?:gaya|gayi|gya|gyi|gai|gaye|ge|diya|diye|dia|di|liya|liye|lia|li|chuka|chuki|chuke)';
// "I've added the naan", "added 2 naan to your order", "add kar diye", "شامل کر دیا".
const ADDED_MORE = new RegExp(
  `\\b(?:i|we)(?:['’]ve| have)?(?: just| also)? added\\b|\\badded\\b[^.!?\\n]{0,40}?\\b(?:to|in|into) (?:your|the) order\\b|\\badd\\w*\\s*(?:ho|hu|kar|kr)\\s*${DONE_FORMS}\\b${NOT_DONE}|(?:شامل|ایڈ)\\s?${URDU_DONE}`,
  'u',
);
// Placed together with "another", "new", "2 more", "naya", "نیا" (not the “new order” command).
const PLACED_WORDING = new RegExp(
  `\\b(?:placed|submitted|added)\\b|\\b(?:place|submit|add)\\w*\\s*(?:ho|hu|kar|kr)\\s*${DONE_FORMS}\\b${NOT_DONE}|(?:پلیس|سبمٹ|موصول|شامل|ایڈ)[^۔.!?؟\\n]{0,10}?${URDU_DONE}`,
  'u',
);
const MORE_WORDING =
  /(?<![“"'‘])\b(?:another|additional|extra|second|separate|new|naya|nayi|naye|doosra|doosri|dusra|dusri)\b|\b(?:\d+|one|two|three|four|five) more\b|(?<![“"'‘\p{L}\p{M}])(?:نیا|نئی|نئے|دوسرا|دوسری)(?![\p{L}\p{M}])/u;
const ordersMore = (value: string) =>
  ADDED_MORE.test(value) ||
  value
    .split(/[.!?۔؟\n]+/u)
    .some((sentence) => PLACED_WORDING.test(sentence) && MORE_WORDING.test(sentence));
// A payment said to be received, verified or confirmed: never the AI's to say, before or after
// the order, since restaurant staff check every transfer themselves. Not a condition ("once we
// receive the payment"), unless the condition is in an earlier clause ("after checking, we have
// received your payment"); not a general statement ("JazzCash payments are verified by our
// staff") or a process ("your payment is being verified").
const NOT_IF = '(?<!\\b(?:once|when|after|until|till|if|before|jab|agar)\\b[^.!?,;\\n]{0,40})';
const PAYMENT_EN = new RegExp(
  `${NOT_IF}(?:\\b(?:payments?|transfers?|transactions?|amount|money|jazz ?cash|easy ?paisa)\\b[^.!?\\n]{0,30}?(?<!\\b(?:be|to|being) )(?<!\\b(?:payments|transfers) (?:are|get)\\b[^.!?\\n]{0,20})\\b(?:rec(?:ei|ie)ved|verified|cleared|credited|confirmed|successful|went through|gone through|came through)\\b|\\b(?:rec(?:ei|ie)ved|got|verified|confirmed)\\s+(?:(?:your|the|aap ki)\\s+)?(?:(?:jazz ?cash|easy ?paisa|bank)\\s+)?(?:payments?|transfers?|money|amount)\\b)`,
  'u',
);
// Also "wasool/mosool ho gayi", "accept ho gaya" and a bare "payment ho gayi" (not "kya payment
// ho gayi hai?", a question back).
const PAYMENT_ROMAN = new RegExp(
  `${NOT_IF}(?:\\b(?:payment|adaigi|adaegi|paise|paisay|pese|transfer|amount|raqam|jazz ?cash|easy ?paisa)\\b[^.!?\\n]{0,30}?\\b(?:(?:receive|recieve|confirm|verify|clear|submit|place|accept|wasool|vasool|wusool|wasul|mosool|mausool|tasdeeq|tasdiq)\\w*\\s*(?:ho|hu|kar|kr)\\s*|(?:mil|aa|pohanch|pahunch)\\s+)(?:gaya|gayi|gya|gyi|gai|gaye|gae|ge|chuka|chuki|chuke|liya|li|lia|diya|di|dia)\\b${NOT_DONE}|\\b(?:payment|adaigi|adaegi|transfer)\\b[^.!?\\n]{0,15}?\\bho\\s*(?:gaya|gayi|gya|gyi|gai|chuka|chuki)\\b${NOT_DONE}(?![^.!?,;\\n]*[?؟]))`,
  'u',
);
const PAYMENT_URDU = new RegExp(
  `(?:ادائیگی|پیمنٹ|رقم|ٹرانسفر|پیسے|جاز ?کیش|ایزی ?پیسہ)[^۔.!?؟\\n]{0,30}?(?:(?:موصول|وصول|تصدیق|کلیئر|کنفرم|پلیس|سبمٹ|ریسیو|قبول)[^۔.!?؟\\n]{0,10}?${URDU_DONE}|(?:مل|آ|پہنچ)\\s?(?:گیا|گئی|گئے|چکا|چکی|چکے)(?![\\p{L}\\p{M}]))|(?:ادائیگی|پیمنٹ|ٹرانسفر)\\s?ہو\\s?(?:گیا|گئی|گئے|چکا|چکی|چکے)(?![\\p{L}\\p{M}])(?![^۔.!?؟،,\\n]*[?؟])`,
  'u',
);
const METHOD_WORDS: Record<PaymentMethod, string> = {
  cash: 'cash(?: on delivery| at pickup)?',
  jazzcash: 'jazz ?cash',
  easypaisa: 'easy ?paisa',
  bank_transfer: 'bank transfers?',
};
// "JazzCash accepted hai", "Yes, Easypaisa payments are accepted": true of a way the restaurant
// takes payment, not an order outcome, so it is taken out before the check. Only the
// restaurant's own methods, said in the present tense of all payments, in a sentence that says
// nothing about the order: never "JazzCash payment accepted", "your payment via JazzCash is
// accepted" or "your order with cash on delivery is accepted".
function withoutAcceptedMethods(text: string, methods: readonly PaymentMethod[]): string {
  if (!methods.length) return text;
  const name = `(?:${methods.map((method) => METHOD_WORDS[method]).join('|')})`;
  const general = new RegExp(
    `(?<!\\b(?:your|the|aap ki|aapki|aap ka|aapka) )(?<!\\b(?:payments?|transfers?|transactions?|money|amount|paise|paisay|raqam|adaigi)\\b[^.!?\\n]{0,20})\\b${name}(?:\\s*(?:,|/|&|and|or|aur|ya)\\s*${name})*(?: payments| transfers)?(?: (?:is|are)(?: (?:also|both|all|bhi))? accepted| accepted (?:hai|hain|hota hai|hote hain|bhi hai|bhi hain))\\b`,
    'giu',
  );
  return text.replace(/[^.!?\n]+/gu, (sentence) =>
    /\border\b|آرڈر/iu.test(sentence) ? sentence : sentence.replace(general, ' '),
  );
}
const RUPEE_PRICE =
  /\d[\d,]*(?:\.\d+)?\s*(?:\/-|(?:rupees?|rupay|rupaye|rupaiye|rupe|rupiya|rs|pkr)\b|روپے|روپیہ|روپئے|روپیے)|(?:\b(?:rupees?|rupay|rupaye)|روپے)\s*\d|(?:\b(?:qeemat|keemat|kimat)\b|قیمت|ٹوٹل)\s*(?:[:=]\s*)?\d/u;
function unsafeModelText(
  text: string,
  submitted = false,
  methods: readonly PaymentMethod[] = [],
): boolean {
  if (ENGLISH_PRICE.test(text) || ENGLISH_OUTCOME.test(withoutAcceptedMethods(text, methods)))
    return true;
  const value = normalize(text);
  return (
    RUPEE_PRICE.test(value) ||
    ROMAN_OUTCOME.test(value) ||
    URDU_OUTCOME.test(value) ||
    ENGLISH_STATUS.test(value) ||
    PAYMENT_EN.test(value) ||
    PAYMENT_ROMAN.test(value) ||
    PAYMENT_URDU.test(value) ||
    (ENGLISH_PLACED.test(text) && (!submitted || !ORDER_PLACED.test(value))) ||
    (submitted && ordersMore(value)) ||
    (!submitted &&
      (ROMAN_PLACED.test(value) || URDU_PLACED.test(value) || ENGLISH_RECEIVED.test(value)))
  );
}

// Allergens in English, Roman Urdu and Urdu. A dish named after one ("doodh patti", "anda
// paratha", "peanut shake", "til naan") is not a question, so they count only in a question
// about what a dish contains or whether it is safe. Fish, prawns, eggs and milk are also sold as
// dishes, so "fish hai kya?", "is there any fish?" or "eggs in stock?" ask what is on the menu;
// only the other (ingredient) allergens count in a bare question ("nuts?", "peanuts hain kya").
const FOOD_ALLERGENS =
  'milk|eggs?|prawns?|shrimps?|crabs?|lobsters?|fish|anda|anday|ande|andey|doodh|dudh|jheenga|jhinga|machli|machhli';
const INGREDIENT_ALLERGENS =
  '(?:tree )?nuts?|peanuts?|almonds?|cashews?|pistachios?|walnuts?|gluten|wheat|dairy|lactose|shellfish|sesame|soy|soya|mustard|moong ?phali|mung ?phali|mong ?phali|badam|kaju|pista|akhrot|meva|mewa|til|gandum';
const ALLERGENS = `${INGREDIENT_ALLERGENS}|${FOOD_ALLERGENS}`;
const URDU_INGREDIENTS =
  'مونگ پھلی|مونگپھلی|گری|گریاں|میوہ|میوے|بادام|کاجو|پستہ|پستے|اخروٹ|گلوٹین|گندم|تل|سویا';
const URDU_ALLERGENS = `${URDU_INGREDIENTS}|انڈا|انڈے|دودھ|جھینگا|جھینگے|مچھلی`;
// A whole Urdu word: "تل" is not the end of "قتل".
const urduWord = (words: string) => `(?<![\\p{L}\\p{M}])(?:${words})(?![\\p{L}\\p{M}])`;
const ALLERGY_WORDS = /\bal+erg|\bal+erj|\bintoleran|\bc(?:o)?eliac\b|\banaphyla|الرج|حساسیت/u;
// "in it", "isme", "is mein", "biryani mein", "ismein", "usme": the dish the question is about.
const ROMAN_IN =
  '(?:mein|me|main|mai|mei|men|andar|(?:is|us|iss|uss|isi|usi|in|un)(?:me|mein|main|mai|men|mei|mn|my))';
const ROMAN_HAS =
  '(?:hai|hain|he|hy|h|hota|hoti|hote|dala|daala|dali|dalta|dalte|dalti|parta|padta|parti|padti|hoga|hogi|honge)';
// "in the biryani", "inside the naan", "in it": not "in stock", "in the menu", "in the lunch
// menu", "in this week's deals", "in the evening" or "in garlic sauce" (a dish's name).
const NOT_IN =
  'menu|stock|evening|morning|night|afternoon|weekend|winter|summer|restaurant|shop|branch|outlet|today|tonight|tomorrow|season|week|month|deals?|specials?';
const MENU_NEXT =
  "(?:\\p{L}+(?:['’]s)? ){1,2}(?:menu|stock|deals?|specials?|restaurant|shop|branch|outlet)\\b";
const DET = 'the|your|ur|this|that|my|our';
const IN_WHAT = `it|them|these|those|(?:this|that)(?! \\p{L})|(?:${DET}) (?!(?:${NOT_IN})\\b|${MENU_NEXT})\\p{L}+`;
const EN_IN = `\\b(?:in|inside) (?:${IN_WHAT})\\b`;
// Also a bare dish word, as WhatsApp English often has it: "is there egg in naan".
const BARE_DISH = `(?!(?:${DET}|a|an|${NOT_IN}|lunch|dinner|breakfast)\\b|${MENU_NEXT})\\p{L}+`;
const EN_IN_BARE = `\\b(?:in|inside) (?:${IN_WHAT}|${BARE_DISH})\\b`;
const NOT_MENU = '(?!\\s+(?:in|on) (?:the |our |your |ur )?(?:menu|stock)\\b)';
// Asking for an ingredient to be added is an order, not a question about a dish: "can I get egg
// in my paratha?", "extra egg in my burger?", "add prawns in the fried rice".
const NOT_REQUEST =
  '(?<!\\b(?:get|add|put|extra|with|want|need|more|give|send|bring) (?:an? |some |more |extra )?)';
const ALLERGEN_QUESTION = new RegExp(
  [
    `\\b(?:${ALLERGENS})[- ]?free\\b`,
    `\\bfree (?:of|from) (?:any )?(?:${ALLERGENS})\\b`,
    `\\bcontain(?:s|ing)?\\b[^.!?]{0,40}\\b(?:${ALLERGENS})\\b`,
    // "is there any dairy in the korma?", "are there nuts?"; "is there fish in the biryani?".
    `\\b(?:is|are) there (?:any |some )?(?:${INGREDIENT_ALLERGENS})\\b${NOT_MENU}(?=\\s*(?:[?.!؟]|$|in\\b|inside\\b|added\\b|used\\b))`,
    // "is there egg in it", "any milk in kheer", "is there egg or milk in the naan": a food also
    // sold as a dish once a dish it would be in follows, with or without "?" (not "is there any
    // fish?", "any fish in stock?").
    `${NOT_REQUEST}\\b(?:(?:is|are) there (?:any |some )?|any )(?:${FOOD_ALLERGENS})(?: (?:or|and) (?:${FOOD_ALLERGENS}))?(?: (?:used|added|put|mixed|cooked))? ${EN_IN_BARE}`,
    `${NOT_REQUEST}\\b(?:${ALLERGENS})(?: (?:used|added|put|mixed|cooked))? ${EN_IN}[^.!]*\\?`,
    // "egg in naan?": one bare dish word and the "?" (not "prawns in garlic sauce?").
    `${NOT_REQUEST}\\b(?:${FOOD_ALLERGENS}) (?:in|inside) ${BARE_DISH}\\s*[?؟]`,
    // "do you put egg in the naan?", "does it come with egg?": asking, where "can you add egg
    // in it?" or "I will add egg paratha" orders.
    `\\b(?:do|does|did|will|would)\\s+(?:[^\\s.!?]+\\s+){1,2}(?:put|add|mix|use)\\s+(?:any\\s+|some\\s+|an?\\s+)?(?:${ALLERGENS})\\b`,
    `\\bcomes?\\s+with\\s+(?:any\\s+)?(?:${ALLERGENS})\\b[^.!]*\\?`,
    // "any peanuts in the karahi?", "any nuts?"
    `\\bany (?:${INGREDIENT_ALLERGENS})\\b${NOT_MENU}(?=\\s*(?:[?.!؟]|$|in\\b|on\\b|inside\\b|added\\b|used\\b))`,
    `\\b(?:does|do|did|will)\\s+(?!you\\b|u\\b|we\\b|i\\b)(?:\\S+\\s+){0,3}(?:have|has|use|contain)\\s+(?:any\\s+|some\\s+)?(?:${ALLERGENS})\\b`,
    `\\b(?:have|has)\\s+(?:any\\s+)?(?:${ALLERGENS}) in (?:it|them|this|that)\\b`,
    `\\b(?:made|cooked|fried|prepared)\\s+(?:with|in|using)\\s+(?:any\\s+)?(?:\\S+\\s+)?(?:${ALLERGENS})\\b`,
    `\\b(?:${ALLERGENS})\\b[^.!?]{0,30}\\bsafe\\b|\\bsafe\\b[^.!?]{0,30}\\b(?:${ALLERGENS})\\b`,
    `\\b(?:${INGREDIENT_ALLERGENS}) in (?!(?:the |our |your |ur )?(?:menu|stock)\\b|today\\b)[^.!]*\\?`,
    // "isme nuts hain?", "kya ismein anda hai?", "biryani mein nuts?", "biryani me koi nuts to
    // nahi?", "naan mein anda to nahi". A food also sold as a dish needs "hai", "to nahi" or
    // "?": "paratha mein anda" and "paratha mein anda dala hua chahiye" are orders.
    `(?<!\\b(?:menu|stock|give|send|get|bring|show|tell|for|to|let|suggest|recommend|order|make|serve|add|want|need|cook|find|fry) )\\b${ROMAN_IN} (?:koi |kuch |bhi )?(?:(?:${ALLERGENS})(?: (?:to |bhi )?(?:nahi |nahin |nai )?${ROMAN_HAS}\\b(?! (?:hua|hui|hue|huwa) (?:chahiye|chahye|chaiye|ho|hona|de|do|dein|dena|dijiye|bhejein|bhej)\\b)|(?: (?:to |bhi )?(?:nahi|nahin|nai))?\\s*[?؟]|(?: (?:to|bhi) (?:nahi|nahin|nai))\\s*$)|(?:${INGREDIENT_ALLERGENS})(?: (?:to |bhi )?(?:nahi|nahin|nai))?\\s*$)`,
    // "nuts hain is mein?", "nuts hai isme?", "nuts isme hain?"
    `\\b(?:${ALLERGENS}) (?:(?:hai|hain|h|he|hy) )?(?:to |bhi )?(?:is|us|iss|uss) ?(?:me|mein|main|mai|men|mei)\\b`,
    // "anda dala hai?", "doodh parta hai?", "peanut oil use hota hai?": put into the dish (not
    // "anda dala hua paratha chahiye", an order).
    `\\b(?:${ALLERGENS}) (?:to |bhi )?(?:nahi |nahin )?(?:dala|daala|dali|dalta|dalte|dalti|parta|padta|parti|padti)\\b(?=\\s*(?:hai|hain|he|hy|h|hota|hoti|hote|gaya|gayi|kya|na)\\b|\\s*[?؟]|\\s*$)`,
    `\\b(?:${ALLERGENS})(?: oil| ka tel| ki| ka)? (?:use|istemal|istemaal) (?:hota|hoti|hote|karte|karti|kiya|ki)\\b`,
    `\\b(?:${INGREDIENT_ALLERGENS}) (?:to )?(?:nahi |nahin )?(?:hai|hain|hota|hoti) (?:na|kya)\\b`,
    // "nuts?", "any nuts?", "gluten hai?", "koi nuts hain?", "nuts to nahi?"; "koi anda to nahi?"
    // (not "koi fish nahi?", which asks about the menu).
    `^(?:(?:any|koi|kya) )?(?:${INGREDIENT_ALLERGENS})(?: (?:hai|hain|h|he|hy))?(?: (?:to )?(?:nahi|nahin|nai))?(?: (?:kya|na))?\\s*[?؟]+$`,
    `\\bkoi (?:${INGREDIENT_ALLERGENS}) (?:to )?(?:nahi|nahin|hai|hain)\\b|\\bkoi (?:${ALLERGENS}) to (?:nahi|nahin)\\b`,
    `(?<!مینو )میں (?:کوئی |کچھ )?${urduWord(URDU_ALLERGENS)}(?: (?:تو )?(?:نہیں )?(?:ہے|ہیں|ہوتا|ہوتی|ہوتے|ڈالا|ڈالتے|ڈالی|پڑتا|پڑتی|ہوگا|ہوگی)|(?: تو)?(?: نہیں)?\\s*[?؟]+$)`,
    `${urduWord(URDU_INGREDIENTS)} (?:تو )?(?:نہیں )?(?:ہے|ہیں) کیا`,
    `^(?:کیا )?(?:کوئی )?${urduWord(URDU_INGREDIENTS)}(?: (?:ہے|ہیں))?(?: کیا)?\\s*[?؟]+$`,
    `${urduWord(URDU_ALLERGENS)} (?:تو )?(?:نہیں )?(?:ڈالا|ڈالتے|ڈالی|پڑتا|پڑتی)`,
    `${urduWord(URDU_ALLERGENS)}(?: کا تیل| کا| کی)? استعمال (?:ہوتا|ہوتی|ہوتے|کرتے|کیا)`,
    `${urduWord(URDU_ALLERGENS)} سے پاک`,
  ].join('|'),
  'u',
);
/** Whether the customer asks about allergies, or whether a dish contains or is safe from an allergen. */
export const asksAboutAllergens = (text: string) => {
  const value = normalize(text);
  return ALLERGY_WORDS.test(value) || ALLERGEN_QUESTION.test(value);
};
// What the customer says they must avoid: an allergy word, or an allergen named outside a dish
// on the menu. A food also sold as a dish ("anda paratha", "fish tikka", "doodh patti") counts
// only with words saying they can't have it ("anda nahi kha sakta", "I can't have milk").
const INGREDIENT_MENTION = new RegExp(
  `\\b(?:${INGREDIENT_ALLERGENS})\\b|${urduWord(URDU_INGREDIENTS)}`,
  'u',
);
const FOOD_MENTION = new RegExp(
  `\\b(?:${FOOD_ALLERGENS})\\b|${urduWord('انڈا|انڈے|دودھ|جھینگا|جھینگے|مچھلی')}`,
  'u',
);
// Saying a food is to be avoided, or upsets them: "I can't have", "my son doesn't eat", "suit
// nahi karta", "hazam nahi hota", "takleef hoti hai", "makes me sick", "ہضم نہیں". "Without" and
// "bina" count next to the food ("without egg", "anday ke bina"), not "without sugar".
const RESTRICTION = new RegExp(
  [
    `\\b(?:can['’]?t|cannot|can not|don['’]?t|do not|does ?n['’]?t|does not|won['’]?t|will not|shouldn['’]?t|should not|must not) (?:have|eat|take|tolerate|digest|drink)\\b`,
    `\\b(?:avoid\\w*|intoleran\\w*|sensitiv\\w*|react\\w*|upsets?|masla|masle|masail|problem|issue|parhez|perhez|dikkat|dikat|diqqat|takleef|takleif|takliif|taklif)\\b`,
    `\\b(?:makes?|made) me (?:sick|ill)\\b|\\b(?:suit|hazam|hazm) (?:nahi|nahin|nai|nhi)\\b`,
    `\\b(?:without|bina) (?:\\p{L}+ ){0,2}(?:${FOOD_ALLERGENS})\\b|\\b(?:${FOOD_ALLERGENS}) (?:\\p{L}+ ){0,2}bina\\b`,
    `\\b(?:nahi|nahin|nai|nhi) (?:kha|khaa|khana|khani|khata|khati|khate|chahiye|chahye|chaiye|leta|leti|lete)\\b`,
    'نہیں کھا|نہیں چاہی|مسئل|پرہیز|بغیر|سوٹ نہیں|ہضم نہیں|تکلیف|دقت',
  ].join('|'),
  'u',
);
// A dish label that is the allergen's own word ("fish" for Fish Tikka).
const ALLERGEN_LABEL = new RegExp(`^(?:${ALLERGENS}|${URDU_ALLERGENS})$`, 'u');
function namesAvoidedAllergen(text: string, products: Product[], companyId: string): boolean {
  const value = normalize(text);
  if (ALLERGY_WORDS.test(value)) return true;
  const restricted = RESTRICTION.test(value);
  // Dishes on the menu are taken out first, longest names first, also as a plural ("badam
  // shakes", "anda parathay"). A label that is the allergen's own word stays when the customer
  // says they can't have it: "I cannot eat fish" names fish, whatever the menu calls "fish".
  const words = (text: string) => normalize(text.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' '));
  const labels = products
    .filter((product) => product.companyId === companyId)
    .flatMap((product) => [product.name, ...product.aliases])
    .map(words)
    .filter((label) => label && !(restricted && ALLERGEN_LABEL.test(label)))
    .sort((a, b) => b.length - a.length);
  let rest = ` ${words(value)} `;
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rest = rest.replace(new RegExp(` ${escaped}(?:s|es|y|ay|e)?(?= )`, 'gu'), ' ');
  }
  return INGREDIENT_MENTION.test(rest) || (FOOD_MENTION.test(rest) && restricted);
}
// AI wording that vouches for a dish to someone who named an allergen, beyond the general
// assurances below: "Bilkul, aap kha sakte hain", "Yes, totally fine for you", "It only has
// chicken, rice and spices", "Nahi ji, isme nahi hota". A question back ("Is that okay for
// you?", "Would pickup be fine for you?") vouches for nothing, but "Yes, it is totally fine for
// you, shall I add one?" does; and "stock mein nahi hai" is about the menu.
const ALLERGEN_CONTEXT_ASSURANCE = new RegExp(
  [
    `\\b(?:kha|khaa) ?(?:sakte|sakti|sakta|saktay|skte|skti|lein|len)\\b`,
    `(?<!(?:^|[.!?,;؟،]\\s*)(?:is|are|was|would|will|does|do|did|can|could|shall|should|kya)\\b[^.!?,;\\n]{0,40})\\b(?:fine|okay|ok|suitable|alright) (?:for|to) (?:you|your|eat|kids|children|everyone|anyone)\\b`,
    `\\b(?:can|could|may) safely (?:eat|have|enjoy|order)\\b|\\b(?:eat|have|enjoy|order) (?:it|this|that|them) (?:safely|without (?:any )?(?:worr(?:y|ies)|problems?|issues?|risk|fear))\\b`,
    `\\bonly (?:has|contains?|uses?|includes?)\\b|\\b(?:contains?|has|includes?|uses) only\\b|\\bmade (?:with|from|of|using) only\\b|\\bnothing but\\b`,
    `\\b(?:nahi|nahin|nai|nhi) (?:dala|daala|dali|dalta|dalte|dalti|parta|padta|parti|padti)\\b`,
    `(?<!\\b(?:menu|stock|cart|deals?|specials?) )\\b${ROMAN_IN} (?:\\p{L}+ ){0,2}(?:nahi|nahin|nai|nhi) (?:hota|hoti|hote|hai|hain)\\b`,
    `\\b(?:sirf|bas) [^.!?\\n]{0,40}\\b(?:dala|daala|dalta|dalte|parta|padta|use)\\b`,
    `کھا سکت|کھا لیں|نہیں (?:ڈالا|ڈالتے|ڈالی|پڑتا|پڑتی)|اس میں (?:\\S+ ){0,2}نہیں (?:ہوتا|ہوتی|ہوتے|ہے|ہیں)|صرف [^۔.!?؟\\n]{0,40}(?:ڈالا|ڈالتے|ڈالی|پڑتا|پڑتی)`,
  ].join('|'),
  'u',
);
// "No fish today" or "we don't have doodh patti" is about the menu, so "no …" and "don't …"
// count only for the allergens people ask to avoid.
const AVOIDED =
  '(?:tree )?nuts?|peanuts?|almonds?|cashews?|gluten|dairy|lactose|eggs?|shellfish|sesame|soy|soya|allergens?|moong ?phali|mung ?phali|badam|kaju|meva|mewa';
const SAFETY_ASSURANCE = new RegExp(
  [
    `\\b(?:${ALLERGENS}|allerg(?:y|en|ens|ies))[- ]?free\\b`,
    `\\b(?:allerg(?:y|en)|nut|peanut)[- ]?(?:safe|friendly)\\b`,
    `\\bsafe (?:for|to) (?:eat|you|your|people|someone|anyone|those|kids|children|everyone|allerg\\w*|nut\\w*|peanut\\w*|gluten|c(?:o)?eliac|dairy|lactose)\\b`,
    `\\b(?:no|zero|free of|free from|contains no|without any) (?:${AVOIDED})\\b`,
    // "no milk in it", "made without eggs", "eggless": not "no fish today" or "no fish in stock".
    `\\b(?:no|zero) (?:${FOOD_ALLERGENS})\\b(?=[^.!?\\n]{0,20}\\b(?:in|inside)\\b(?! (?:stock|the menu|our menu|menu)\\b))`,
    `\\b(?:made )?without (?:any )?(?:${ALLERGENS})\\b`,
    `\\b(?:eggs?|dairy|milk|nuts?|gluten)[- ]?less\\b`,
    // "it doesn't contain eggs", "we don't put egg in our naan"; not "we don't have doodh patti".
    `\\b(?:does ?n[o'’]?t|did ?n[o'’]?t|won['’]t|will not|never) (?:contain|have|include|use|put|add|mix) (?:any )?(?:${ALLERGENS})\\b`,
    `\\bdo ?n[o'’]?t (?:contain|include|use|put|add|mix) (?:any )?(?:${ALLERGENS})\\b`,
    `\\b(?:${ALLERGENS}) (?:(?:to|bhi|bilkul|koi) )?(?:nahi|nahin|nai|nhi)\\b`,
    `\\bsafe (?:hai|hain|he|hy|h|hoga|rahega)\\b|\\bbilkul safe\\b`,
    `\\ballerg\\w* (?:ka |ki |ke )?(?:koi )?(?:khatra|masla|problem|issue) nahi`,
  ].join('|'),
  'u',
);
const URDU_ASSURANCE = new RegExp(
  `(?:${URDU_ALLERGENS}|الرج\\S*) (?:(?:تو|بھی|بالکل|کوئی) )?(?:نہیں|سے پاک)|(?:${URDU_ALLERGENS}|الرج)[^۔.!?؟]*محفوظ`,
  'u',
);
/** Whether AI wording reassures a customer that a dish is safe from an allergen. */
export const assuresSafety = (text: string) => {
  const value = normalize(text);
  return SAFETY_ASSURANCE.test(value) || URDU_ASSURANCE.test(value);
};
// A saving or discount stated in AI wording, read on normalized text: "save 250", "saves you
// 250", "30% off", "20 percent discount", "250 ki bachat", "۲۵۰ روپے کی بچت". "Off" never takes
// a number after it ("we're off on 25 December"). Only the engine states a deal's saving.
const SAVING_DIGIT = '[\\d۰-۹٠-٩]';
// The whole amount after a saving word, with its unit: "save 25%", not "save 2".
const SAVING_AMOUNT = `${SAVING_DIGIT}[\\d۰-۹٠-٩,]*(?:\\.\\d+)?(?:\\s*(?:%|٪|percent|per cent|fee ?sad|فیصد))?`;
const SAVING_CLAIM = new RegExp(
  [
    `\\b(?:save[sd]?|saving|savings|discount(?:ed|s)?|bachat|bachao|bachaen|bachayen|bachaiye|riayat|riyayat|chhoot|chhut)\\b\\s*(?:(?:of|you|up ?to|upto|rs\\.?|pkr|tak|ki|ka)\\s*)*${SAVING_AMOUNT}`,
    `${SAVING_DIGIT}[\\d,]*(?:\\.\\d+)?\\s*(?:%|percent|per cent|fee ?sad|rupees?|rupay|rupaye|rs|pkr)?\\s*(?:ki |ka |tak )?(?:off|discount|saving|savings|bachat|bachao|riayat|riyayat|chhoot|chhut)\\b`,
    `${SAVING_DIGIT}[\\d,]*\\s*(?:%|٪|فیصد|روپے|روپیہ)?\\s*(?:کی\\s*|تک\\s*)?${urduWord('بچت|رعایت|چھوٹ|ڈسکاؤنٹ|آف')}`,
    `${urduWord('بچت|رعایت|چھوٹ|ڈسکاؤنٹ')}\\s*(?:\\S+\\s*){0,2}?${SAVING_AMOUNT}`,
  ].join('|'),
  'gu',
);
// Whether the owner wrote this saving phrase, as whole words and the whole amount: "save 20%"
// is not "save 25%", "save 200" or "save 20" said of a percentage.
const ownerSays = (owner: string, phrase: string) =>
  occurrencesOf(owner, phrase).some(
    ([, end]) => !/^(?:\s*(?:[%٪]|percent|per cent|fee ?sad|فیصد)|[.,]\d)/u.test(owner.slice(end)),
  );
function requestedOptions(products: Product[], text: string): string[] {
  return [
    ...new Set(
      products
        .flatMap((product) => [
          ...product.variants,
          ...product.modifiers,
          ...(product.deal?.choices.flatMap((group) => group.options) ?? []),
        ])
        .filter((option) => contains(text, option.name))
        .map((option) => option.name),
    ),
  ];
}
// Where a name is written in a normalized text, as whole words: [start, end] each time.
function occurrencesOf(value: string, phrase: string): [number, number][] {
  const p = normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!p) return [];
  return [...value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, 'gu'))].map(
    (m) => [m.index, m.index + m[0].length],
  );
}
// The text with these stretches blanked to a comma (a break between parts of the message),
// keeping every other character where it was.
const blanked = (value: string, spans: [number, number][]) =>
  [...spans]
    .sort((a, b) => b[0] - a[0])
    .reduce(
      (text, [start, end]) =>
        `${text.slice(0, start)}${','.padEnd(end - start, ' ')}${text.slice(end)}`,
      value,
    );
// The text with these stretches (deals named, merged where they touch) each read as another item
// that ends its part of the message: one word written there that is no dish's (`dishWords`) nor
// a number ("deal" for "deal 1", or for "zinger deal" beside a Zinger Burger), then "item" (so
// no number after it reads as "deal 2" again) and a break. A count before a stretch stays with
// it: "zinger, 2 zinger deal" is one zinger, where `blanked` would leave the 2 alone in a part
// of its own. A count written straight after one (TRAILING_COUNT) is the deal's and goes with
// it, so "deal 4 x3 + chicken burger x1" is one burger, unless the next stretch starts there
// ("deal 2 3" naming Deal 3 too).
// TRAILING_COUNT: "x3", "×3", "*3", "qty 3", "(3)", "3 dafa", or a number alone ("3", "3x", "- 3")
// where its part of the message ends with it ("deal 2 2 + chicken burger 3"). A number alone
// before a dish ("zinger deal 2 chicken burger", "deal 4 2x zinger") may be the dish's: it stays.
const TRAILING_COUNT =
  /^\s*(?:(?:x|×|\*|qty)\s*\d{1,2}|\(\s*\d{1,2}\s*\)|\d{1,2}\s*dafa|-?\s*\d{1,2}\s*(?:x|×)?(?=\s*(?:$|[+/,;&|\n!?-]|\.(?!\d))))(?![\p{L}\p{N}])/u;
function masked(value: string, spans: [number, number][], dishWords: Set<string>): string {
  const merged: [number, number][] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const stretches = merged.map(([start, end], k) => {
    const count = TRAILING_COUNT.exec(value.slice(end))?.[0].length ?? 0;
    return {
      start,
      named: end,
      end: end + count <= (merged[k + 1]?.[0] ?? Infinity) ? end + count : end,
    };
  });
  return stretches.reduceRight((text, { start, named, end }) => {
    const word = normalizeCatalogText(text.slice(start, named))
      .split(' ')
      .find((w) => w && !dishWords.has(w) && !/^\d+$/.test(w));
    return `${text.slice(0, start)} ${word ? `${word} ` : ''}item , ${text.slice(end)}`;
  }, value);
}
/**
 * The message as dishes are read on a menu with deals: each deal named in it (`spans`, in the
 * normalized text), with its picks, read as another item there (see masked), so "4 zinger deal,
 * aur ek zinger burger" is one burger. With no deal named it is the message itself.
 */
function dishTextOf(text: string, dishes: Product[], spans: [number, number][]): string {
  if (!spans.length) return text;
  const value = normalize(text);
  const breaks = normalize(text.trim().replace(/\s*\n\s*/gu, '\u0000'));
  const lined = breaks.length === value.length ? breaks.replace(/\u0000/gu, '\n') : value;
  return masked(
    lined,
    spans,
    new Set(
      dishes
        .flatMap((p) => [p.name, ...p.aliases])
        .flatMap((label) => normalizeCatalogText(label).split(' ')),
    ),
  );
}
// A deal's picks from option names the customer gave ("sprite"): one per choice, in order.
function picksNamed(product: Product, names: string[]): string[] {
  const used = new Set<string>();
  return (product.deal?.choices ?? []).flatMap((group) => {
    const option = [...group.options]
      .sort((a, b) => b.name.length - a.name.length)
      .find((o) => !used.has(o.name) && names.some((name) => contains(name, o.name)));
    if (!option) return [];
    used.add(option.name);
    return [option.id];
  });
}
// An option named with these words before or after it is not chosen: "no sprite", "without
// sprite", "remove sprite", "sprite nahi", "sprite mat dena", "sprite hatao".
const TAKEN_BACK_BEFORE =
  /(?:^|[^\p{L}\p{N}])(?:no|not|without|remove|delete|bina|بغیر|نکال(?:یں|و)?|ہٹا(?:ئیں|و)?)\s*$/u;
const TAKEN_BACK_AFTER =
  /^\s*(?:nahi|nahin|nai|nhi|mat|hatao|hata do|hata dein|nikalo|nikal do|nikal dein|نہیں|مت|ہٹا|نکال)(?![\p{L}\p{N}])/u;
// A count of its own next to an option: "1 sprite", "do sprite", "sprite x2".
const COUNT_BEFORE =
  /(?:^|[^\p{L}\p{N}])(?:\d{1,2}|x\d{1,2}|one|two|three|ek|aik|teen|ایک|تین|(?<!(?:de|dey|kar|kr|le|bhej|la|دے|کر)\s)(?:do|دو))\s*x?\s*$/u;
const COUNT_AFTER = /^\s*x?\d{1,2}x?(?![\p{L}\p{N}])/u;
/**
 * Where these option names (normalized) are written in `named` as picks, in order: not inside a
 * longer dish name written there ("loaded fries", "sprite 345ml"), not taken back ("no sprite",
 * "sprite nahi"), and without a count of their own where a dish carries the name ("1 sprite").
 * Of names that overlap, the longest.
 */
function writtenPicks(names: string[], named: string, dishes: Product[]) {
  const labels = [
    ...new Set(dishes.flatMap((dish) => [dish.name, ...dish.aliases]).map((l) => normalize(l))),
  ];
  const longer = labels.filter((label) =>
    names.some((name) => label !== name && occurrencesOf(label, name).length),
  );
  const rest = blanked(
    named,
    longer.flatMap((label) => occurrencesOf(named, label)),
  );
  const sold = (name: string) => labels.some((label) => occurrencesOf(label, name).length);
  const written = names
    .flatMap((name) => occurrencesOf(rest, name).map(([start, end]) => ({ name, start, end })))
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const all: typeof written = [];
  for (const w of written) if (!all.some((f) => f.start < w.end && w.start < f.end)) all.push(w);
  return all
    .filter(
      ({ name, start, end }) =>
        !TAKEN_BACK_BEFORE.test(rest.slice(0, start)) &&
        !TAKEN_BACK_AFTER.test(rest.slice(end)) &&
        !(
          sold(name) &&
          (COUNT_BEFORE.test(rest.slice(0, start)) || COUNT_AFTER.test(rest.slice(end)))
        ),
    )
    .sort((a, b) => a.start - b.start);
}
// "One more", "another", "extra", "alag se": the option's drink ordered beside the deal's answer.
const ANOTHER_BEFORE =
  /(?:^|[^\p{L}\p{N}])(?:one more|another|ek aur|aik aur|aur ek|aur aik|extra|alag)\s*$/u;
const ANOTHER_AFTER = /^\s*(?:alag|separately|separate|extra)(?![\p{L}\p{N}])/u;
/**
 * The deal's answer named a second time on its own, with a count or "one more", "extra", "alag
 * se" beside it ("sprite, aur ek sprite alag se", "pepsi, and one more pepsi"): the message
 * without the answer, which orders that drink as well. Otherwise undefined: "pepsi, haan pepsi
 * hi" is one answer said twice. `named` is the message with deals' names blanked.
 */
function orderedAgain(name: string, named: string, dishes: Product[]): string | undefined {
  const option = normalize(name);
  const longer = dishes
    .flatMap((dish) => [dish.name, ...dish.aliases])
    .map((label) => normalize(label))
    .filter((label) => label !== option && occurrencesOf(label, option).length);
  const rest = blanked(
    named,
    longer.flatMap((label) => occurrencesOf(named, label)),
  );
  const places = occurrencesOf(rest, option);
  const apart = ([start, end]: [number, number]) =>
    COUNT_BEFORE.test(rest.slice(0, start)) ||
    COUNT_AFTER.test(rest.slice(end)) ||
    ANOTHER_BEFORE.test(rest.slice(0, start)) ||
    ANOTHER_AFTER.test(rest.slice(end));
  const answer = places.find((place) => !apart(place));
  return answer && places.some(apart) ? blanked(named, [answer]) : undefined;
}
// Words that turn down the deal whose choice is asked ("nahi", "rehne do", "remove", "skip"),
// and words that may come with them. Wanting words ("chahiye", "want") turn it down only
// right after "nahi", "don't" or "not": "nahi, deal 1 chahiye" still orders it.
const DECLINES = new Set(
  'no not nope nah nahi nahin nai nhi mat dont don never nevermind leave cancel skip remove delete hatao hata rehne rehnay chhoro chhor chor choro chhod chhodo forget نہیں مت رہنے چھوڑ چھوڑیں چھوڑو ہٹا ہٹائیں ہٹاؤ نکال نکالیں منسوخ'.split(
    ' ',
  ),
);
const WITH_DECLINES = new Set(
  'do dein den karo kar kardo krdo kr dena it that this the a any i me mujhe muje ye yeh wo woh please pls plz thanks thank thx you ok okay ji jee bhai abhi ab bas sorry about mind t chahiye chahye chaiye chahie want need add دیں دو کریں کرو کر مجھے یہ وہ جی بس ابھی اب چاہیے چاہئے'.split(
    ' ',
  ),
);
const WANTED = /\b(?:chahiye|chahye|chaiye|chahie|want|need|add)\b|چاہیے|چاہئے/u;
const NOT_WANTED =
  /\b(?:do not|don['’]?t|not|no)\s+(?:want|add|need)\b|\b(?:nahi|nahin|nai|nhi)\s+(?:chahiye|chahye|chaiye|chahie)\b|نہیں\s*(?:چاہیے|چاہئے)/u;
/**
 * The deal whose choice is asked, turned down: "deal 1 nahi chahiye", "ڈیل 1 نہیں چاہیے", "nahi
 * rehne do", "no thanks", "remove deal 1", "skip the deal". Nothing else may be said beside the
 * refusal but the deal's name (as the bot reads deals' names) or a deal word, so "no sprite",
 * "nahi, 2", "deal 1 nahi, deal 2" or "drink nahi chahiye" are not.
 */
function declinesDeal(products: Product[], product: Product, value: string): boolean {
  const options = new Set(
    product.deal!.choices.flatMap((group) =>
      group.options.map((o) => normalizeCatalogText(o.name)),
    ),
  );
  const named = findDealMentions(products, product.companyId, value)
    .filter((mention) => mention.products.includes(product))
    .flatMap((mention) => mention.spans)
    .filter(([start, end]) => !options.has(normalizeCatalogText(value.slice(start, end))));
  const words = normalizeCatalogText(named.length ? blanked(value, named) : value)
    .split(' ')
    .filter(Boolean);
  return (
    words.some((word) => DECLINES.has(word)) &&
    words.every((word) => DECLINES.has(word) || WITH_DECLINES.has(word) || DEAL_WORDS.has(word)) &&
    (!WANTED.test(value) || NOT_WANTED.test(value))
  );
}
// Words that may come with a bare answer to the deal's choice: "sprite wala please", "option 2",
// "sprite theek hai", "sprite de do".
const ANSWER_WORDS = new Set(
  'please pls plz wala wali wale waala waali option theek thik hai ok okay ji jee haan han yes chalo bas de do dein dena chahiye chahye chaiye'.split(
    ' ',
  ),
);
/**
 * The answer to "Choose Drink for Deal 1": a number from the list as it was shown, or the name of
 * exactly one option (a name inside a longer one, "coke" in "diet coke", is that one). Names for
 * the next open choices too, in order, fill those as well ("coke aur fries" for Drink, then
 * Side). Anything else, two drinks for one choice or none, is no answer. An option name inside a
 * longer dish name ("loaded fries", "sprite 345ml"), taken back ("no sprite", "sprite nahi"), or
 * with a count of its own where a dish carries that name ("1 sprite") orders or refuses that dish
 * instead. A number from a list the owner has changed since gives no picks: ask again. Names are
 * read in `named`, the text with deals' names blanked ("2 deal 1 coke": the 1 counts no coke).
 */
function answeredPicks(
  product: Product,
  pending: NonNullable<Conversation['pendingDealChoice']>,
  value: string,
  named: string,
  dishes: Product[],
): string[] | undefined {
  const open = product.deal!.choices.filter(
    (group) => !group.options.some((option) => pending.picked.includes(option.id)),
  );
  const asked = open[0];
  if (!asked) return undefined;
  const ordinal = value.match(/^(?:option\s*)?(\d{1,2})(?:st|nd|rd|th)?[.!\s]*$/u)?.[1];
  if (ordinal) {
    if (!pending.optionIds) {
      const option = asked.options[Number(ordinal) - 1];
      return option ? [option.id] : undefined;
    }
    const id = pending.optionIds[Number(ordinal) - 1];
    if (!id) return undefined;
    return pending.groupId === asked.id && asked.options.some((o) => o.id === id) ? [id] : [];
  }
  const names = [...new Set(open.flatMap((group) => group.options.map((o) => normalize(o.name))))];
  const found = writtenPicks(names, named, dishes);
  if (!found.length) return undefined;
  if (open.length === 1 || found.length === 1) {
    if (new Set(found.map((f) => f.name)).size !== 1) return undefined;
    const option = asked.options.find((o) => normalize(o.name) === found[0]!.name);
    return option ? [option.id] : undefined;
  }
  if (found.length > open.length) return undefined;
  const ids: string[] = [];
  for (const [k, f] of found.entries()) {
    const option = open[k]!.options.find((o) => normalize(o.name) === f.name);
    if (!option) return undefined;
    ids.push(option.id);
  }
  return ids;
}
// "koi deal hai?", "deal hai kya", "any deals", "deals dikhao", "کوئی ڈیل ہے": asking about the
// deals, not ordering one.
const DEAL_ASK = new RegExp(
  [
    '[?؟]',
    '^(?:what|which|any|do you|does|is there|are there|koi|kya|kia|konsi|kaunsi|kon si|kaun si|kuch|show|tell|list|see)\\b',
    '\\b(?:hai|hain|he|h)\\s+(?:kya|kia)\\b',
    '\\b(?:kya|kia)\\s+(?:hai|hain)\\b',
    '\\b(?:dikhao|dikha do|dikhayein|dikhaen|dikhain|batao|bata do|batayein|batain|bhejo|bhej do|show|list)\\b',
    '^(?:کوئی|کیا|کون)(?![\\p{L}\\p{M}])',
    'دکھا|بتا|بھیج',
    '(?<![\\p{L}\\p{M}])(?:ہے|ہیں)\\s*(?:کیا)?\\s*$',
  ].join('|'),
  'u',
);
// Words that leave a message only about the deals: "deals", "today's deals", "koi deal hai?",
// "what deals do you have", "deals dikhao", "کوئی ڈیل ہے؟".
const DEAL_FILLERS = new Set(
  'any some your our the all today todays s new latest current special please pls plz koi kuch aaj sab saari sari wali wala ji bhai a an of for on now best good acha achi achha achhi what whats which do does you u have has got is are there show list see tell me us about kya kia konsi kaunsi kon kaun si hai hain he h hy dikhao dikha batao bata bhejo bhej available milegi milega milti milta ki ka ke kitne kitna kitni price rate aap ap pas paas کوئی کچھ آج سب کیا ہے ہیں کون سی دکھائیں دکھاؤ دکھا بتائیں بتاؤ بتا بھیجیں بھیجو آپ کے پاس'.split(
    ' ',
  ),
);
const onlyAboutDeals = (text: string) =>
  normalizeCatalogText(text)
    .split(' ')
    .filter(Boolean)
    .every((word) => DEAL_WORDS.has(word) || DEAL_FILLERS.has(word));
// The same with the words read as the bot reads them, so "کوئی" (which loses its hamza) counts:
// on a menu with deals, a message only about them keeps no dish the AI added.
const READ_FILLERS = new Set([...DEAL_FILLERS].map(normalizeCatalogText));
const asksOnlyAboutDeals = (text: string) =>
  normalizeCatalogText(text)
    .split(' ')
    .filter(Boolean)
    .every((word) => DEAL_WORDS.has(word) || DEAL_FILLERS.has(word) || READ_FILLERS.has(word));
const DEAL_ORDER = new RegExp(
  [
    "\\b(?:chahiye|chahye|chaiye|chahie|chahiyen|dena|de do|dedo|de dein|de den|lena|lunga|lungi|lenge|want|need|add|order|mangwana|mangwani|mangwa do|mangwa dein|bhejna|bhej do|bhej dein|bhej den|karna|karni|i ?['’]?ll (?:take|have)|give me|get me|can i (?:get|have))\\b",
    'چاہیے|چاہئے|دے دیں|دیجیے|لینا|لوں گا|منگوا|بھیجنا|بھیج دیں',
  ].join('|'),
  'u',
);
// A named deal asked about rather than ordered: "deal 2 hai?", "deal 2 hai kya", "kya zinger
// deal milegi". A trailing "hai" alone asks only when nothing else is said ("deal 2 hai"):
// "deal 2, mera naam Ali hai" orders it.
const NAMED_DEAL_QUESTION = new RegExp(
  [
    '^(?:what|which|any|do you|does|is there|are there|koi|kya|kia|konsi|kaunsi|kon si|kaun si)\\b',
    '\\b(?:hai|hain|he|milegi|milega|milti|milta|available)(?:\\s*[?؟]+|\\s+(?:kya|kia)\\s*[?؟]*)$',
    '^(?:کوئی|کیا|کون)(?![\\p{L}\\p{M}])',
    '(?<![\\p{L}\\p{M}])(?:ہے|ہیں|ملے گی|ملے گا)(?:\\s*[?؟]+|\\s*کیا\\s*[?؟]*)$',
  ].join('|'),
  'u',
);
const ENDS_ASKING =
  /(?:\b(?:hai|hain|he|milegi|milega|milti|milta|available)|(?<![\p{L}\p{M}])(?:ہے|ہیں|ملے گی|ملے گا))\s*$/u;
// "offer" said of the restaurant is a verb, not its offers: "do you offer delivery", "delivery
// offer karte hain".
const BEFORE_OFFER_VERB = new Set('do does did you u we they to can will also'.split(' '));
const AFTER_OFFER_VERB = new Set('karte karti karta kartay krte kar kr karo karein'.split(' '));
// The deal words ("deal", "combo", "ڈیل") in the text that name no deal and are no part of a
// dish's name written in it ("Kids Meal"). "meal" alone asks for no deal ("what's the best
// meal?"), only beside one ("meal deals"). Without deals on the menu, "combo" or "offer" is no
// deal word where a dish's name holds it ("combo" beside a Chicken Combo).
function looseDealWords(products: Product[], value: string): RegExpExecArray[] {
  const words = [...value.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  const word = (k: number) => normalizeCatalogText(words[k]?.[0] ?? '');
  const labels = products
    .filter((product) => !product.deal)
    .flatMap((product) => [product.name, ...product.aliases]);
  const named = labels.flatMap((label) => occurrencesOf(value, label));
  const dishWords = new Set(
    products.some((product) => product.deal)
      ? []
      : labels.flatMap((label) => normalizeCatalogText(label).split(' ')),
  );
  return words.filter((m, k) => {
    const w = word(k);
    const one = w.replace(/s$/u, '');
    return (
      DEAL_WORDS.has(w) &&
      one !== 'meal' &&
      !named.some(([start, end]) => start <= m.index && m.index + m[0].length <= end) &&
      !(
        one === 'offer' &&
        (BEFORE_OFFER_VERB.has(word(k - 1)) || AFTER_OFFER_VERB.has(word(k + 1)))
      ) &&
      (ONLY_DEAL_WORDS.has(w) || ![w, one, `${one}s`].some((form) => dishWords.has(form)))
    );
  });
}

/** Deliberately bounded simulator. Production adapters may extract the same actions. */
export function parseActions(
  company: Company,
  products: Product[],
  conversation: Conversation,
  text: string,
): BotAction[] {
  const value = normalize(text);
  const own = products.filter((p) => p.companyId === company.id);
  if (isCartSummaryRequest(text)) return [{ type: 'cart_summary' }];
  // Interruptions and browsing are not answers to an outstanding item choice.
  if (/^(new order|start over|restart|naya order|نیا آرڈر)[.!،۔\s]*$/u.test(value))
    return [{ type: 'new_order' }];
  if (asksToCancelOrder(text)) return [{ type: 'cancel' }];
  if (asksForPerson(text, own)) return [{ type: 'handoff' }];
  // The deal whose choice is asked, turned down: taken off, so no later "sprite" adds it. A deal
  // waiting behind a dish's "which one?" is not what a "no" answers.
  const declined = own.find((p) => p.deal && p.id === conversation.pendingDealChoice?.productId);
  if (declined && !conversation.pendingItemChoice && declinesDeal(products, declined, value))
    return [{ type: 'remove_item', productId: declined.id }];
  if (/\b(?:do not|don't|dont|not|no)\s+(?:want|add|need)|نہیں چاہیے|nahi chahiye/u.test(value))
    return [{ type: 'answer', text: '' }];
  if (
    /^(menu|show menu|show me (?:the )?menu|مینو|menu dikhao|menu bhej(?: do)?)[.!،۔\s]*$/u.test(
      value,
    )
  )
    return [{ type: 'menu' }];
  const earlyResolution = resolveItemMention(products, company.id, text);
  // A word in a deal's name written in full asks nothing: "Half Price Tuesday", "Always
  // Available Combo".
  const dealNames = own
    .filter((p) => p.deal)
    .flatMap((p) => [p.name, ...p.aliases])
    .flatMap((label) => occurrencesOf(value, label));
  const asked = dealNames.length ? blanked(value, dealNames) : value;
  const browsing =
    /^(?:what|which|how much|is |are |do you have|tell me|kitna|kya)|(?:\bprice\b|\bavailable\b|کتنے|قیمت|دستیاب)/u.test(
      asked,
    );
  if (browsing && earlyResolution.kind !== 'none') {
    const candidates =
      earlyResolution.kind === 'unique' ? [earlyResolution.product] : earlyResolution.products;
    const query =
      candidates.length === 1
        ? candidates[0]!.name
        : value
            .split(/\s+/)
            .find(
              (word) =>
                word.length >= 3 &&
                candidates.every((p) => contains(`${p.name} ${p.aliases.join(' ')}`, word)),
            );
    return [{ type: 'menu', query }];
  }
  // Deals are named by their own words only, with any picks written beside them. Counts are read
  // as on a menu without deals, where each deal named is one more item a count may belong to.
  const dealMentions = findDealMentions(products, company.id, value);
  const hasDeals = own.some((p) => p.deal);
  const dishes = own.filter((p) => !p.deal);
  const counted = hasDeals
    ? [...dishes, ...dealMentions.map((mention) => mention.products[0]!)]
    : products;
  // The dishes are read as on a menu without deals, in the message with each deal named read as
  // another item there (see dishTextOf): "zinger, 2 zinger deal" is one zinger.
  const dealSpans = dealMentions.flatMap((mention) => mention.spans);
  const dishText = dishTextOf(text, dishes, dealSpans);
  if (conversation.pendingItemChoice && !browsing) {
    const selected = resolvePendingItemChoice(
      products,
      company.id,
      conversation.pendingItemChoice,
      text,
    );
    // Two deals named ("deal 2 aur 3", "deal 2 3") answer the list with both: the message is
    // read as any other, so neither is lost and no count is taken from the other's number.
    if (selected && !(selected.deal && dealMentions.length > 1)) {
      const requested = [
        ...conversation.pendingItemChoice.requestedOptionNames,
        ...requestedOptions([selected], text),
      ];
      // Only a count written next to the chosen dish, in its own part of the message, changes
      // the one asked about: "3 naan", "naan 3, chicken wali" or "house 12" is not its count,
      // nor the 4 in "chicken wali 4 naan", which may be the naan's. A dish's is read with the
      // deals named taken out: the 4 of "4 zinger deal, aur ek zinger burger" is the deal's.
      const explicitQuantity = !/^option\b/u.test(value)
        ? clearQuantityNear(selected, selected.deal ? text : dishText, counted)
        : undefined;
      return [
        {
          type: 'add_item',
          productId: selected.id,
          quantity: explicitQuantity ?? conversation.pendingItemChoice.quantity,
          variantId:
            selected.variants.find((option) => contains(text, option.name))?.id ??
            selected.variants.find((option) =>
              requested.some((name) => contains(name, option.name)),
            )?.id,
          modifierIds: selected.deal
            ? picksNamed(selected, requested)
            : selected.modifiers
                .filter((option) => requested.some((name) => contains(name, option.name)))
                .map((option) => option.id),
          notes: conversation.pendingItemChoice.notes,
        },
      ];
    }
    if (/^(?:option\s*)?\d+[.!\s]*$/u.test(value))
      return [
        {
          type: 'clarify_item',
          candidateProductIds: conversation.pendingItemChoice.candidateProductIds,
          quantity: conversation.pendingItemChoice.quantity,
          requestedOptionNames: conversation.pendingItemChoice.requestedOptionNames,
          notes: conversation.pendingItemChoice.notes,
          originalText: conversation.pendingItemChoice.originalText,
        },
      ];
  }
  // What is left once the deals and their picks are taken out names dishes only, so "1 zinger
  // deal" never also adds a Zinger burger. Without a deal named it is the message itself.
  const rest = dealSpans.length ? blanked(value, dealSpans) : value;
  // The answer to the deal's open choice ("2", "sprite"), unless another deal is named.
  const pendingDeal = conversation.pendingDealChoice;
  const askedDeal =
    pendingDeal &&
    products.find((p) => p.companyId === company.id && p.id === pendingDeal.productId && p.deal);
  if (
    pendingDeal &&
    askedDeal &&
    !browsing &&
    dealMentions.every((mention) => mention.products.includes(askedDeal))
  ) {
    const drinks = own.filter((p) => !p.deal);
    const picks = answeredPicks(askedDeal, pendingDeal, value, asked, drinks);
    // An option named like a dish the open "which one?" asks about ("pepsi" for Pepsi 345ml or
    // Pepsi 1.5L) answers that question, the one asked last, as on a menu without deals; the deal
    // is not named, so its choice waits (and the bare-answer rule in processTurn never applies).
    const names = askedDeal
      .deal!.choices.flatMap((group) => group.options)
      .filter((option) => picks?.includes(option.id))
      .map((option) => option.name);
    const forDish =
      !dealMentions.length &&
      !!conversation.pendingItemChoice?.candidateProductIds.some((id) => {
        const dish = drinks.find((p) => p.id === id);
        return (
          !!dish &&
          names.some((name) =>
            [dish.name, ...dish.aliases].some(
              (label) => contains(label, name) || contains(name, label),
            ),
          )
        );
      });
    // No new pick (a number from a list since changed): the add asks the choice again.
    if (picks && !forDish) {
      // Picks written beside the deal's name replace those made before for the same choice
      // ("Add 1 Deal 3 with Sprite / Wings" after "coke").
      const choice = (id: string) =>
        askedDeal.deal!.choices.findIndex((group) => group.options.some((o) => o.id === id));
      const said = dealMentions
        .flatMap((mention) => mention.picks)
        .filter((id) => !picks.some((pick) => choice(pick) === choice(id)));
      const earlier = pendingDeal.picked.filter(
        (id) => !said.some((pick) => choice(pick) === choice(id)),
      );
      // The answer's drink ordered again on its own is added too ("sprite, aur ek sprite alag
      // se"), by the dishes that carry that name.
      const again = askedDeal
        .deal!.choices.flatMap((group) => group.options)
        .filter((option) => picks.includes(option.id))
        .flatMap((option): BotAction[] => {
          const rest = orderedAgain(option.name, asked, drinks);
          if (rest === undefined) return [];
          const found = resolveItemMention(
            drinks.filter((p) =>
              [p.name, ...p.aliases].some(
                (label) => occurrencesOf(normalize(label), option.name).length,
              ),
            ),
            company.id,
            rest,
          );
          if (found.kind === 'unique')
            return [
              {
                type: 'add_item',
                productId: found.product.id,
                quantity: found.quantity,
                modifierIds: [],
              },
            ];
          return found.kind === 'ambiguous'
            ? [
                {
                  type: 'clarify_item',
                  candidateProductIds: found.products.slice(0, 12).map((p) => p.id),
                  quantity: found.quantity,
                  requestedOptionNames: requestedOptions(found.products, rest),
                  originalText: text,
                },
              ]
            : [];
        });
      return [
        {
          type: 'add_item',
          productId: askedDeal.id,
          quantity: pendingDeal.quantity,
          modifierIds: [...earlier, ...said, ...picks],
          notes: pendingDeal.notes,
        },
        ...again,
      ];
    }
  }
  // A deal ordered by a deal word alone: the one deal on, or which of them.
  const someDeal = (quantity: number, said: string): BotAction => {
    const on = own.filter((p) => p.deal?.state === 'on');
    if (on.length === 1)
      return { type: 'add_item', productId: on[0]!.id, quantity, modifierIds: [] };
    return on.length
      ? {
          type: 'clarify_item',
          candidateProductIds: on.slice(0, 12).map((p) => p.id),
          quantity,
          requestedOptionNames: requestedOptions(on, said),
          originalText: text,
        }
      : { type: 'menu', query: 'deals' };
  };
  // A deal word that names no deal: a question about the deals ("koi deal hai?"), on any menu,
  // or with deals an order of one of them ("deal chahiye"); never a dish ("deal" is one letter
  // from "daal"). It never takes the place of a dish the message names ("2 biryani, koi offer
  // hai?"), and without deals such a message is read as it always was.
  const loose = dealMentions.length ? [] : looseDealWords(own, value);
  let dealOrdered: BotAction | undefined;
  if (loose.length && onlyAboutDeals(value)) return [{ type: 'menu', query: 'deals' }];
  if (loose.length && hasDeals && earlyResolution.kind === 'none') {
    if (DEAL_ASK.test(value)) return [{ type: 'menu', query: 'deals' }];
    if (DEAL_ORDER.test(value)) return [someDeal(dealWordCount(text), text)];
  } else if (loose.length && hasDeals) {
    // "2 zinger burger aur ek deal chahiye": the burgers, then which deal, by the count in its
    // own part of the message (the dishes' names taken out).
    const dishNames = dishes
      .flatMap((p) => [p.name, ...p.aliases])
      .flatMap((label) => occurrencesOf(value, label));
    const part =
      blanked(value, dishNames)
        .split(CLAUSE_BREAK)
        .find((p) => looseDealWords(own, p).length) ?? '';
    const deal =
      DEAL_ORDER.test(part) && resolveItemMention(dishes, company.id, part).kind === 'none'
        ? someDeal(dealWordCount(part), part)
        : undefined;
    if (deal?.type !== 'menu') dealOrdered = deal;
  }
  // A question about one named deal shows it, unless the message also names a dish ("deal 1 aur
  // 2 fries. deal 2 hai?").
  if (
    dealMentions.length &&
    !DEAL_ORDER.test(value) &&
    (NAMED_DEAL_QUESTION.test(value) || (ENDS_ASKING.test(value) && onlyAboutDeals(rest))) &&
    resolveItemMention(dishes, company.id, rest).kind === 'none'
  )
    return [
      {
        type: 'menu',
        // Several of one name (two Ramadan Deals, a deal named like a dish) are shown together.
        query:
          dealMentions.length === 1 &&
          new Set(dealMentions[0]!.products.map((p) => normalizeCatalogText(p.name))).size === 1
            ? dealMentions[0]!.products[0]!.name
            : 'deals',
      },
    ];
  // A bare "yes" may answer any question, so it means confirm only straight after the review.
  // Otherwise it is an acknowledgement, never a dish ("haan" is one letter from "naan").
  const agreed = consent(text);
  if (
    agreed === 'explicit' ||
    (agreed === 'bare' && isLatestReview(conversation.cart, answeredMessage(conversation, text)))
  )
    return [{ type: 'confirm' }];
  if (agreed === 'bare') return [{ type: 'answer', text: '' }];
  if (
    /^(menu|show menu|show me (?:the )?menu|مینو|menu dikhao|menu bhej(?: do)?|salam|salaam|hello|hi|السلام علیکم)[.!،۔\s]*$/u.test(
      value,
    )
  )
    return [{ type: 'menu' }];
  const explicitProducts = dishes.filter((p) =>
    [p.name, ...p.aliases].some((label) => contains(rest, label)),
  );
  const distinctMentions =
    explicitProducts.length > 1 &&
    explicitProducts.every((p) =>
      [p.name, ...p.aliases].some(
        (label) =>
          contains(rest, label) &&
          !explicitProducts.some(
            (other) =>
              other.id !== p.id &&
              [other.name, ...other.aliases].some(
                (otherLabel) => normalize(otherLabel) === normalize(label),
              ),
          ),
      ),
    );
  const clarify = (candidates: Product[], quantity: number): BotAction => ({
    type: 'clarify_item',
    candidateProductIds: candidates.slice(0, 12).map((product) => product.id),
    quantity,
    requestedOptionNames: requestedOptions(candidates, text),
    originalText: text,
  });
  // "lunch deal" with two lunch deals: which one.
  const unsure = dealMentions.find((mention) => mention.products.length > 1);
  if (unsure) return [clarify(unsure.products, earlyResolution.quantity)];
  // Each deal named: added with its picks, or removed ("remove deal 1").
  const named: { at: number; action: BotAction }[] = dealMentions.map((mention) => {
    const product = mention.products[0]!;
    const prefix = value.slice(Math.max(0, mention.at - 24), mention.at);
    return {
      at: mention.at,
      action: /\b(remove|delete|hatao)\b|نکال|ہٹا/u.test(prefix)
        ? { type: 'remove_item', productId: product.id }
        : {
            type: 'add_item',
            productId: product.id,
            quantity:
              mention.quantity ?? quantityOfMention(product, mention.phrase, text, products) ?? 1,
            modifierIds: mention.picks,
          },
    };
  });
  // A dish asked about by a word several share ("burger"), beside a deal, is asked about after
  // the deal is added.
  const dishResolution = hasDeals
    ? resolveItemMention(dishes, company.id, dishText)
    : earlyResolution;
  if (dishResolution.kind === 'ambiguous' && !distinctMentions)
    return [
      ...named.map((entry) => entry.action),
      clarify(dishResolution.products, dishResolution.quantity),
    ];
  const matches = dishes
    .map((product) => ({
      product,
      alias: [product.name, ...product.aliases]
        .filter((alias) => contains(rest, alias))
        .sort((a, b) => b.length - a.length)[0],
    }))
    .filter((m): m is { product: Product; alias: string } => !!m.alias)
    .map((m) => ({ ...m, at: rest.indexOf(normalize(m.alias)) }))
    .sort((a, b) => a.at - b.at);
  // Beside a deal named, a dish read only by a typo is left to the AI.
  if (!matches.length && !dealMentions.length) {
    const detailLike =
      /(?:my name is|name\s*:|mera naam|mera nam|میرا نام|نام\s*:|address\s*:|pata\s*:|پتہ\s*:|پتا\s*:|\bpickup\b|\bdelivery\b|پک اپ|ڈیلیوری|ڈلیوری)/iu.test(
        text,
      );
    // An ambiguous one was asked about above.
    const resolution = detailLike ? ({ kind: 'none', quantity: 1 } as const) : dishResolution;
    if (resolution.kind === 'unique') {
      if (
        /^(?:what|how much|is |are |do you have|tell me|kitna|kya)|(?:\bprice\b|\bavailable\b|کتنے|قیمت|دستیاب)/u.test(
          value,
        )
      )
        return [{ type: 'menu', query: resolution.product.name }];
      return [
        {
          type: 'add_item',
          productId: resolution.product.id,
          quantity: resolution.quantity,
          modifierIds: [],
        },
        ...(dealOrdered ? [dealOrdered] : []),
      ];
    }
  }
  const sameMention = matches.filter(
    (match) =>
      match.at === matches[0]!.at && normalize(match.alias) === normalize(matches[0]!.alias),
  );
  if (sameMention.length > 1)
    return [
      ...named.map((entry) => entry.action),
      {
        type: 'clarify_item',
        candidateProductIds: sameMention.slice(0, 12).map((match) => match.product.id),
        quantity: Math.max(
          1,
          Math.min(
            50,
            quantityOfMention(sameMention[0]!.product, sameMention[0]!.alias, dishText, counted) ??
              1,
          ),
        ),
        requestedOptionNames: requestedOptions(
          sameMention.map((match) => match.product),
          text,
        ),
        originalText: text,
      },
    ];
  const [first] = [
    ...dealMentions.map((mention) => ({ at: mention.at, product: mention.products[0]! })),
    ...matches,
  ].sort((a, b) => a.at - b.at);
  if (
    first &&
    /^(?:what|how much|is |are |do you have|tell me|kitna|kya)|(?:\bprice\b|\bavailable\b|کتنے|قیمت|دستیاب)/u.test(
      asked,
    )
  )
    return [{ type: 'menu', query: first.product.name }];
  if (
    first &&
    /\b(?:do not|don't|dont|not|no)\s+(?:want|add|need)|نہیں چاہیے|nahi chahiye/u.test(value)
  )
    return [{ type: 'answer', text: '' }];
  for (const { product, alias, at } of matches) {
    const prefix = rest.slice(Math.max(0, at - 24), at);
    if (/\b(remove|delete|hatao)\b|نکال|ہٹا/u.test(prefix)) {
      named.push({ at, action: { type: 'remove_item', productId: product.id } });
      continue;
    }
    const variant = product.variants.find((v) => contains(rest, v.name));
    const modifiers = product.modifiers.filter(
      (m) =>
        contains(rest, m.name) &&
        !/\b(without|no|remove)\s*$/u.test(
          rest.slice(
            Math.max(0, rest.indexOf(normalize(m.name)) - 15),
            rest.indexOf(normalize(m.name)),
          ),
        ),
    );
    named.push({
      at,
      action: {
        type: 'add_item',
        productId: product.id,
        // The count next to this mention, in its own part of the message: "naan 3, chicken
        // biryani" and "naan 3 chicken biryani" give the biryani 1 and the naan 3.
        quantity: quantityOfMention(product, alias, dishText, counted) ?? 1,
        variantId: variant?.id,
        modifierIds: modifiers.map((m) => m.id),
      },
    });
  }
  const actions: BotAction[] = named.sort((a, b) => a.at - b.at).map((entry) => entry.action);
  if (dealOrdered) actions.push(dealOrdered);
  const details: Extract<BotAction, { type: 'set_details' }> = { type: 'set_details' };
  if (/\b(pickup|pick up|takeaway|take away)\b|پک اپ|لے جاؤں|لے جاوں/u.test(value))
    details.fulfillment = 'pickup';
  if (/\b(delivery|deliver)\b|ڈیلیوری|ڈلیوری/u.test(value)) details.fulfillment = 'delivery';
  const name = text
    .match(
      /(?:my name is|name\s*:|mera naam|mera nam|میرا نام|نام\s*:)\s*(.+?)(?:\s+(?:hai|ہے))?(?:[.!،۔]|$)/iu,
    )?.[1]
    ?.trim();
  if (name) details.customerName = name;
  const address = text.match(/(?:address\s*:|pata\s*:|پتہ\s*:|پتا\s*:)\s*(.+)$/iu)?.[1]?.trim();
  if (address) details.address = address;
  const zone = company.deliveryZones.find((z) => contains(value, z.name));
  if (zone) details.zone = zone.name;
  if (Object.keys(details).length > 1) actions.push(details);
  if (/\b(review|checkout|check out|total|done|bas)\b|جائزہ|کل رقم|بس/u.test(value))
    actions.push({ type: 'review' });
  if (actions.length) return actions;
  if (
    conversation.cart.items.length &&
    !conversation.cart.customerName &&
    conversation.cart.fulfillment &&
    /^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(text.trim())
  )
    return [{ type: 'set_details', customerName: text.trim() }];
  return [{ type: 'answer', text: '' }];
}

// Traces that mean the application changed or refused what the model proposed.
const CORRECTION_TRACES = new Set([
  'ambiguous_addition_prevented',
  'item_choice_resolved',
  'deal_choice_resolved',
  'browse_cart_mutation_prevented',
  'unconfirmed_model_action_rejected',
  'fresh_confirmation_required',
  'duplicate_submission_prevented',
  'invalid_model_grounding_ignored',
  'unsafe_model_response_ignored',
  'invalid_model_prompt_ignored',
  'response_fallback',
  'invented_link_ignored',
  'allergy_assurance_ignored',
  'allergy_question_guarded',
]);

// The owner's approved answer about allergies (an FAQ or knowledge entry), sent word for word.
// One whose question is about allergies wins over one that only mentions them in its answer.
function approvedAllergyAnswer(company: Company, menuLink?: string): string | undefined {
  const about = (text: string) => ALLERGY_WORDS.test(normalize(text));
  const faq =
    company.faqs.find((f) => about(f.question) && f.answer.trim()) ??
    company.faqs.find((f) => about(f.answer));
  return faq ? fillMenuLink(faq.answer, menuLink).trim() || undefined : undefined;
}
const allergyNotice = (company: Company, lang: Language) =>
  say(
    lang,
    `We can’t confirm allergens or ingredients in this chat. A staff member will reply here to help you.${company.phone ? ` You can also call us on ${company.phone}.` : ''}`,
    `ہم اس چیٹ میں الرجی یا اجزا کی تصدیق نہیں کر سکتے۔ عملے کا ایک رکن یہیں آپ کو جواب دے گا۔${company.phone ? ` آپ ہمیں ${leftToRight(company.phone)} پر کال بھی کر سکتے ہیں۔` : ''}`,
    `Hum is chat mein allergy ya ingredients confirm nahi kar sakte. Staff ka koi member yahin aap ko jawab dega.${company.phone ? ` Aap hamein ${company.phone} par call bhi kar sakte hain.` : ''}`,
  );

// A question about the order this chat placed. Wording that names the order ("where is my
// order?", "order kahan hai?", "آرڈر کہاں ہے؟", "order status") is always about it, and so is a
// bare "kitni der?" or "any update?".
const ORDER_STATUS_QUESTION =
  /\bwhere(?:'s| is)? (?:is )?(?:my |the |our )?(?:order|food|rider|delivery)\b|\border status\b|^status\b|\bstatus of (?:my |the )?order\b|\btrack(?:ing)? (?:my |the )?order\b|\bwhen will (?:my order|the order|the food) (?:come|arrive|be ready|reach|be delivered)\b|\bis (?:my order|the order) (?:ready|coming|on the way|confirmed|accepted)\b|\b(?:order|rider)\s+(?:abhi tak\s+)?(?:kahan|kidhar|kab)\b|\border ka (?:kya )?status\b|\bstatus (?:kya hai|batao|bata dein|batayein)\b|(?:آرڈر|رائیڈر)\s(?:\S+\s){0,3}?کہاں|آرڈر کی (?:صورتحال|حالت)|اسٹیٹس|سٹیٹس/u;
// "How long?" wording that may also be asked before ordering ("kitni der mein delivery hoti
// hai?", "how long does delivery take?"): about the order only while it is current. Never
// where the restaurant is ("restaurant kahan hai?", "ریسٹورنٹ کہاں ہے؟") or how long pickup
// usually takes ("how long does pickup take?").
const PLACE_WORDS =
  '(?:restaurant|resturant|shop|branch|outlet|location|address|dukaan|dukan|jagah|place|area|aap|ap|apka|aapka|apki|aapki|ap ka|aap ka|ap ki|aap ki)';
const URDU_PLACE_WORDS = '(?:ریسٹورنٹ|ریسٹورانٹ|دکان|دُکان|برانچ|پتہ|پتا|لوکیشن|جگہ|آپ)';
const GENERAL_STATUS = new RegExp(
  `\\bhow (?:much )?long(?:er)?\\b(?! (?:is|are|was|were) (?!it\\b)\\p{L}| (?:are|r|do|does) (?:you|u) (?:stay )?open| (?:does|do|will) (?:a |the )?(?:pickup|takeaway|take away)\\b)|\\bwhen will it (?:come|arrive|be ready|reach|be delivered)\\b|\\bis it (?:ready|coming|on the way|confirmed|accepted)\\b|\\bany updates?\\b(?! (?:on|to|in|about) (?:the |your |ur )?(?:menu|prices?|rates?|deals?|timings?|hours)\\b)|\\beta\\b|\\bkhana\\s+(?:abhi tak\\s+)?(?:kahan|kidhar|kab)\\b|(?<!\\b${PLACE_WORDS} )\\bkahan (?:hai|reh gaya|pohncha)\\b|\\bkitni der\\b|\\bkitna (?:time|waqt)\\b|\\bkab (?:tak )?(?:aaye?ga|aayega|ayega|milega|pohnche?ga|ready hoga|aaega)\\b|کھانا\\s(?:\\S+\\s){0,3}?کہاں|(?<!${URDU_PLACE_WORDS} )کہاں (?:ہے|رہ گیا|پہنچا)|کتنی دیر|کب (?:تک )?(?:آئے گا|ملے گا|پہنچے گا)`,
  'u',
);
// The whole message is such a question ("kitni der?", "any update?", "how much longer?").
const BARE_STATUS =
  /^(?:(?:bhai|bhaiya|sir|ji|yaar|yar|please|pls|aur|or|and|so|abhi|ab|بھائی|جی|اور) )*(?:how (?:much )?long(?:er)?(?: (?:will it take|now|more))?|any updates?|eta|kitni der(?: aur| or| hai| lagegi| lage gi| hogi| aur lagegi)?|kitna (?:time|waqt)(?: aur| lagega| or)?|kab (?:tak )?(?:aaye?ga|aayega|ayega|milega|aaega)|kahan (?:hai|reh gaya)|کتنی دیر(?: اور| ہے| لگے گی)?|کب (?:تک )?(?:آئے گا|ملے گا))(?: (?:bhai|bhaiya|sir|ji|yaar|yar|please|pls|بھائی|جی))*[\s.!?؟۔]*$/u;
const FINISHED_STATUSES: OrderStatus[] = ['completed', 'rejected', 'cancelled'];
// An order still open with the restaurant that has not changed for this long (twice as long
// while it waits for acceptance): staff never closed it.
const ORDER_LEFT_OPEN_MS = 12 * 60 * 60 * 1000;
/**
 * Whether an order staff never closed (accepted, ready or out for delivery and not updated for
 * 12 hours, or pending for 24) should stop holding the chat's cart, so a returning customer's
 * new order is taken. Its status is not changed.
 */
export function orderLeftOpen(order: Pick<Order, 'status' | 'updatedAt'>, now: string): boolean {
  if (FINISHED_STATUSES.includes(order.status)) return false;
  const age = Date.parse(now) - Date.parse(order.updatedAt);
  return Number.isFinite(age) && age > (order.status === 'pending' ? 2 : 1) * ORDER_LEFT_OPEN_MS;
}
/**
 * Whether general wording ("kitni der?") can be about this order: it is still with the
 * restaurant and changed in the last 24 hours, or it finished in the last 2 hours.
 */
export function orderStillCurrent(
  order: Pick<Order, 'status' | 'updatedAt'>,
  now: string,
): boolean {
  const age = Date.parse(now) - Date.parse(order.updatedAt);
  if (!Number.isFinite(age)) return false;
  return age <= (FINISHED_STATUSES.includes(order.status) ? 2 : 24) * 60 * 60 * 1000;
}
/**
 * Whether the message asks about the order this chat placed. Without the order, only wording
 * that is about an order whatever its age counts; with it, "how long" wording counts too while
 * the order is current (see orderStillCurrent), so a returning customer's "kitni der mein
 * delivery hoti hai?" is not answered with last week's order.
 */
export function asksOrderStatus(
  text: string,
  order?: Pick<Order, 'status' | 'updatedAt'>,
  now?: string,
): boolean {
  const value = normalize(text);
  return (
    ORDER_STATUS_QUESTION.test(value) ||
    BARE_STATUS.test(value) ||
    (!!order && !!now && orderStillCurrent(order, now) && GENERAL_STATUS.test(value))
  );
}
/** The engine's status line for a placed order: its status and how long since it last changed. */
export function orderStatusText(
  lang: Language,
  order: NonNullable<TurnInput['latestOrder']>,
  now: string,
): string {
  const ref = order.reference;
  const pickup = order.fulfillment === 'pickup';
  const again = say(
    lang,
    ' Send “new order” to order again.',
    ' دوبارہ آرڈر کے لیے “نیا آرڈر” لکھیں۔',
    ' Dobara order ke liye “new order” likhein.',
  );
  const status: Record<OrderStatus, string> = {
    pending: say(
      lang,
      `Order ${ref} is waiting for the restaurant to accept it.`,
      `آرڈر ${ref} ریسٹورنٹ کی منظوری کا انتظار کر رہا ہے۔`,
      `Order ${ref} restaurant ki manzoori ka intezar kar raha hai.`,
    ),
    accepted: say(
      lang,
      `The restaurant has accepted order ${ref}.`,
      `ریسٹورنٹ نے آرڈر ${ref} منظور کر لیا ہے۔`,
      `Restaurant ne order ${ref} accept kar liya hai.`,
    ),
    preparing: say(
      lang,
      `The restaurant has accepted order ${ref} and it is being prepared now.`,
      `ریسٹورنٹ نے آرڈر ${ref} منظور کر لیا ہے اور یہ اب تیار ہو رہا ہے۔`,
      `Restaurant ne order ${ref} accept kar liya hai aur ab yeh tayyar ho raha hai.`,
    ),
    ready: pickup
      ? say(
          lang,
          `Order ${ref} is ready for pickup.`,
          `آرڈر ${ref} پک اپ کے لیے تیار ہے۔`,
          `Order ${ref} pickup ke liye tayyar hai.`,
        )
      : say(lang, `Order ${ref} is ready.`, `آرڈر ${ref} تیار ہے۔`, `Order ${ref} tayyar hai.`),
    out_for_delivery: say(
      lang,
      `Order ${ref} is out for delivery.`,
      `آرڈر ${ref} ڈیلیوری کے لیے روانہ ہو چکا ہے۔`,
      `Order ${ref} delivery ke liye nikal chuka hai.`,
    ),
    completed:
      say(
        lang,
        `Order ${ref} is completed.`,
        `آرڈر ${ref} مکمل ہو چکا ہے۔`,
        `Order ${ref} mukammal ho chuka hai.`,
      ) + again,
    rejected:
      say(
        lang,
        `The restaurant could not accept order ${ref}.`,
        `ریسٹورنٹ آرڈر ${ref} قبول نہیں کر سکا۔`,
        `Restaurant order ${ref} accept nahi kar saka.`,
      ) + again,
    cancelled:
      say(
        lang,
        `Order ${ref} was cancelled.`,
        `آرڈر ${ref} منسوخ ہو چکا ہے۔`,
        `Order ${ref} cancel ho chuka hai.`,
      ) + again,
  };
  // Minutes for the first hour, then about how many hours, then days.
  const minutes = Math.floor((Date.parse(now) - Date.parse(order.updatedAt)) / 60000);
  const hours = Math.round(minutes / 60);
  const days = Math.round(minutes / 1440);
  const updated =
    !Number.isFinite(minutes) || minutes < 1
      ? say(lang, 'Last update: just now.', 'آخری اپڈیٹ: ابھی ابھی۔', 'Aakhri update: abhi abhi.')
      : minutes < 60
        ? say(
            lang,
            `Last update: ${minutes} minute${minutes === 1 ? '' : 's'} ago.`,
            `آخری اپڈیٹ: ${minutes} منٹ پہلے۔`,
            `Aakhri update: ${minutes} minute pehle.`,
          )
        : hours < 24
          ? say(
              lang,
              `Last update: about ${hours === 1 ? 'an hour' : `${hours} hours`} ago.`,
              `آخری اپڈیٹ: تقریباً ${hours === 1 ? 'ایک گھنٹہ' : `${hours} گھنٹے`} پہلے۔`,
              `Aakhri update: taqreeban ${hours === 1 ? 'ek ghanta' : `${hours} ghante`} pehle.`,
            )
          : say(
              lang,
              `Last update: about ${days === 1 ? 'a day' : `${days} days`} ago.`,
              `آخری اپڈیٹ: تقریباً ${days === 1 ? 'ایک' : days} دن پہلے۔`,
              `Aakhri update: taqreeban ${days === 1 ? 'ek' : days} din pehle.`,
            );
  return `${status[order.status] ?? say(lang, `Order ${ref} has been received.`, `آرڈر ${ref} موصول ہوا۔`, `Order ${ref} receive ho gaya.`)}\n${updated}`;
}

export function processTurn(
  company: Company,
  products: Product[],
  conversation: Conversation,
  input: TurnInput,
  actions?: BotAction[],
  modelResponse?: ModelResponse,
): TurnResult {
  if (conversation.companyId !== company.id) throw new Error('Company access denied.');
  if (!Number.isFinite(new Date(input.now).getTime()))
    throw new Error('Invalid message timestamp.');
  const next: Conversation = structuredClone(conversation);
  const configuration = botConfig(company);
  // AI wording that states prices or outcomes, or links to a website the owner never gave.
  // The owner's hosts are only collected when the AI wrote a link, which is rare. A link the
  // customer or staff sent in the history the AI sees may be repeated: its hosts are read one
  // short word at a time, so a long or crafted message never costs more than reading it.
  let ownerHosts: Set<string> | undefined;
  const hosts = () =>
    (ownerHosts ??= linkAllowlist(company, configuration, input.appHost, [
      input.menuLink,
      ...products
        .filter((product) => product.companyId === company.id)
        .flatMap((product) => [product.name, product.description]),
    ]));
  // Never the bot's own earlier wording, so an invented link can't vouch for itself.
  let chatHosts: Set<string> | undefined;
  const fromChat = (host: string) => {
    chatHosts ??= new Set(
      [
        input.text,
        ...conversation.messages
          .slice(-MODEL_LIMITS.historyMessages)
          .filter((m) => m.role === 'customer' || m.role === 'staff')
          .map((m) => m.text.slice(0, MODEL_LIMITS.historyMessageChars)),
      ]
        .join('\n')
        .split(/[^\p{L}\p{N}.@-]+/u)
        .filter((word) => word.includes('.') && word.length <= 253)
        .flatMap(hostsIn),
    );
    return [...chatHosts].some((known) => host === known || host.endsWith(`.${known}`));
  };
  const invents = (text: string) => inventsLink(text, hosts, fromChat);
  // The deals this turn sells (shared/deals.ts), and their names, longest first, so a check
  // never reads a deal's name as words: "Deal 2 saves you money" states no saving, and "egg in
  // the zinger deal?" asks about a dish.
  const deals = products.filter((product) => product.companyId === company.id && product.deal);
  const withoutDeals = (text: string, by: string) => withoutDealNames(deals, text, by);
  // The menu page's own address is not an outcome claim, whatever words its slug holds, and
  // nor is saying the restaurant takes a payment method it does take. The cart is read when the
  // text is checked, so a cart this turn started afresh (an order staff never closed) is no
  // longer the submitted one: "your order has been placed" is not true of it.
  const claims = (text: string) => {
    const wording = input.menuLink ? text.replaceAll(input.menuLink, '') : text;
    return (
      unsafeModelText(
        wording,
        conversation.cart.status === 'submitted' && next.cart.status === 'submitted',
        paymentMethods(company),
      ) || claimsSaving(wording)
    );
  };
  // An allergy reassurance only in the owner's own approved words, quoted exactly.
  const ownerWording = [
    ...company.faqs.map((faq) => faq.answer),
    ...configuration.behaviorRules.map((rule) => rule.response),
  ].map((text) => normalize(text));
  const assures = (text: string) =>
    assuresSafety(text) &&
    !ownerWording.some((owner) => !!text.trim() && owner === normalize(text));
  // A saving or discount only in the engine's words, once there are deals, unless the owner
  // wrote that very phrase (an approved answer, a rule, a deal's description).
  const savingWording = deals.length
    ? [...ownerWording, ...deals.map((deal) => normalize(deal.description))]
    : [];
  const claimsSaving = (text: string) =>
    deals.length > 0 &&
    [...withoutDeals(text, ' ').matchAll(SAVING_CLAIM)].some(
      (match) => !savingWording.some((owner) => ownerSays(owner, match[0].trim())),
    );
  const unsafe = (text: string) => claims(text) || assures(text) || invents(text);
  // The menu page link is filled in (or left out) where each text is chosen, before any
  // check reads it: a text left empty counts as missing, so the turn never goes silent.
  if (modelResponse?.text.includes('{menu_link}'))
    modelResponse = { ...modelResponse, text: fillMenuLink(modelResponse.text, input.menuLink) };
  const handoffMessage = fillMenuLink(configuration.handoffMessage ?? '', input.menuLink);
  const traces: string[] = [];
  if (next.messages.some((m) => m.id === input.messageId))
    return {
      conversation: next,
      reply: next.messages.find((m) => m.id === `${input.messageId}:reply`)?.text ?? '',
      traces: ['duplicate_message_ignored'],
    };
  // A deal choice asked about a deal that was since deleted can't be answered.
  if (
    next.pendingDealChoice &&
    !deals.some((deal) => deal.id === next.pendingDealChoice!.productId)
  )
    delete next.pendingDealChoice;
  next.language = languageOf(customerWords(input.text, input.action), next.language);
  if (configuration.language !== 'auto') next.language = configuration.language;
  next.botVersion = company.bot?.published?.version;
  if (next.channel === 'demo')
    next.testContext = {
      target: input.testTarget ?? 'draft',
      configRevision:
        input.testTarget === 'published'
          ? (company.bot?.published?.version ?? 0)
          : (company.bot?.revision ?? 0),
      provider: company.ai.provider,
      model: company.ai.model,
      catalogSource: company.catalogSource,
    };
  next.messages.push({
    id: input.messageId,
    role: 'customer',
    text: input.text.slice(0, 4000),
    createdAt: input.now,
  });
  next.version += 1;
  next.updatedAt = input.now;
  next.lastInboundAt = input.now;
  const lang = next.language;
  const cart = next.cart;
  const initialReview = {
    revision: cart.reviewedRevision,
    hash: cart.quoteHash,
    status: cart.status,
  };
  // A typed confirmation answers the message just before it. It counts only when that message
  // is the review the cart awaits (not an answer, a staff message or a notice since), the review
  // reached the customer, and it is under an hour old.
  const reviewAnswered = isLatestReview(conversation.cart, conversation.messages.at(-1));
  // A review is timed by when it was really shown: a late message's reply goes out when it is
  // processed (receivedAt), not at the time the message was sent.
  const shownAt = turnInstant(input);
  const reviewAge = cart.reviewedAt ? Date.parse(shownAt) - Date.parse(cart.reviewedAt) : NaN;
  const reviewFresh = reviewAge >= 0 && reviewAge <= REVIEW_FRESH_MS;
  // Deal times are read on the restaurant's clock at that same moment.
  const clock = deals.length ? localClock(company.timezone, shownAt) : undefined;
  // A deal in the cart that isn't on now stops the whole cart from being priced: named, with
  // how to take it out, and nothing stays confirmable (a cart reviewed at 14:58 for a deal on
  // until 15:00 is not placed at 15:01).
  const dealsOn = () => {
    const problem = dealProblem(company, products, cart, lang, clock);
    if (!problem) return;
    if (cart.status === 'awaiting_confirmation') unreview(cart);
    traces.push('deal_not_on');
    throw new Error(problem);
  };
  // The review text this turn shows, so finish() records which reply carried it.
  let shownReview: string | undefined;
  const showReview = () => {
    dealsOn();
    const text = review(company, products, cart, lang, shownAt);
    if (cart.status === 'awaiting_confirmation') shownReview = text;
    return text;
  };
  // Only a choice the restaurant offers: with one option, it is the customer's without asking.
  const offered = offeredFulfillment(company);
  const settleFulfillment = () => {
    if (!cart.fulfillment && (offered === 'pickup' || offered === 'delivery'))
      cart.fulfillment = offered;
  };
  // Allergy questions get the owner's approved words, or a fixed notice and a person; never AI
  // wording. A follow-up question straight after one about a dish or "it" ("and the karahi?",
  // "so it's safe?") is guarded too; a menu request or another topic is not.
  const lastAsked = conversation.messages
    .slice(-4)
    .reverse()
    .find((m) => m.role === 'customer');
  // An AI answer that vouches for a dish to a customer who named an allergen ("isme nuts?" →
  // "Bilkul, aap kha sakte hain") makes it an allergy question too, however it was worded.
  const aiWording = [
    modelResponse?.text ?? '',
    ...(actions ?? []).map((action) => (action.type === 'answer' ? action.text : '')),
  ];
  // A deal's name is a dish's: "is there egg in the zinger deal?" asks what a dish contains.
  const asksAllergy = (text: string) =>
    asksAboutAllergens(text) ||
    (deals.length > 0 && asksAboutAllergens(withoutDeals(text, 'dish')));
  const allergyQuestion =
    !input.action &&
    (asksAllergy(input.text) ||
      (aiWording.some((text) => ALLERGEN_CONTEXT_ASSURANCE.test(normalize(text))) &&
        namesAvoidedAllergen(input.text, products, company.id)) ||
      (!!lastAsked &&
        asksAllergy(lastAsked.text) &&
        /[?؟]/u.test(input.text) &&
        !asksForMenu(input.text) &&
        (/\b(?:safe|it|its|it's|that|this|them|these|those|bhi|yeh|ye|woh|wo)\b|محفوظ|یہ|وہ|بھی/u.test(
          normalize(input.text),
        ) ||
          resolveItemMention(products, company.id, input.text).kind !== 'none')));
  let reply = '',
    order: Order | undefined;
  const cartFacts: string[] = [];
  let correctedInterpretation = false;
  let recapCorrected = false;
  let tooManyActions = false;
  let modelAnswer: string | undefined;
  let answerUnsafe = false;
  let answerUnsafeTrace = 'unsafe_model_response_ignored';
  // A cart change refused because the cart was cancelled: only the engine may word that reply.
  let cancelledCartRefused = false;
  let incompleteReviewQuestion: string | undefined;
  // The deal's open choice (or why it can't be asked), shown once per turn and last.
  let dealQuestion: string | undefined;
  const finish = (): TurnResult => {
    if (traces.includes('human_mode_message_saved'))
      return { conversation: next, reply: '', traces };
    const validGrounding = new Set([
      ...products
        .filter((product) => product.companyId === company.id)
        .map((product) => product.id),
      ...company.faqs.map((_, index) => `faq:${index}`),
      ...configuration.behaviorRules.map((rule) => rule.id),
      'business:hours',
      'business:address',
      'business:phone',
      'business:delivery',
    ]);
    const grounded =
      !modelResponse?.groundingIds?.length ||
      modelResponse.groundingIds.every((id) => validGrounding.has(id));
    const validAskFor =
      !modelResponse?.askFor ||
      modelResponse.askFor === 'none' ||
      (modelResponse.askFor === 'items' && !cart.items.length) ||
      (modelResponse.askFor === 'anything_else' && cart.items.length > 0) ||
      (modelResponse.askFor === 'fulfillment' && !cart.fulfillment) ||
      (modelResponse.askFor === 'name' && !cart.customerName?.trim()) ||
      (modelResponse.askFor === 'zone' && cart.fulfillment === 'delivery' && !cart.zone) ||
      (modelResponse.askFor === 'address' &&
        cart.fulfillment === 'delivery' &&
        !cart.address?.trim());
    // A follow-up label that does not fit the cart is a labelling slip, not a sign the AI
    // could not answer. "What would you like?" / "anything else?" cannot re-ask a detail
    // the customer already gave, so an answer-only reply keeps that wording; any other
    // mismatched question is replaced by the engine's own next question. Neither hands
    // the chat to staff: that paused the bot for a customer who had only said "hi".
    const harmlessAskFor =
      modelResponse?.askFor === 'items' || modelResponse?.askFor === 'anything_else';
    const answerOnlyLabelSlip =
      !validAskFor && grounded && !!modelResponse?.text.trim() && !unsafe(modelResponse.text);
    const matchedRule = configuration.behaviorRules.find(
      (rule) => rule.enabled && rule.id === modelResponse?.matchedRuleId,
    );
    if (matchedRule) traces.push(`behavior_rule:${matchedRule.id}`);
    const exactResponse =
      matchedRule?.responseMode === 'exact'
        ? fillMenuLink(matchedRule.response ?? '', input.menuLink)
        : '';
    const transactional = traces.some((trace) =>
      [
        'add_item',
        'remove_item',
        'set_details',
        'review',
        'cart_summary',
        'confirm',
        'cancel',
        'new_order',
        'menu',
        'clarify_item',
        'deal_choice_asked',
      ].includes(trace),
    );
    const protectedReply =
      correctedInterpretation ||
      traces.some(
        (trace) =>
          trace.startsWith('validation_failed:') ||
          [
            'duplicate_submission_prevented',
            'unconfirmed_model_action_rejected',
            'fresh_confirmation_required',
            'confirm',
            'order_status',
          ].includes(trace),
      ) ||
      (traces.includes('review') && !incompleteReviewQuestion) ||
      // The cancellation itself, or a change the cancelled cart refused. A later question is
      // answered normally rather than handed to staff.
      (cart.status === 'cancelled' && (traces.includes('cancel') || cancelledCartRefused));
    if (cartFacts.length) reply = [cartFacts.join('\n'), reply].filter(Boolean).join('\n\n');
    // The deal's choice comes last, after what was added (see settleDealChoice).
    if (dealQuestion && next.mode === 'bot')
      reply = [reply, dealQuestion].filter(Boolean).join('\n\n');
    // Explanation only: record which source wrote each part of the reply.
    let parts: ReplyPart[] = [];
    const answerByModel = !!modelAnswer && reply.includes(modelAnswer);
    if (reply) {
      if (transactional || cartFacts.length || (!traces.includes('approved_faq') && !answerByModel))
        parts.push('engine');
      if (traces.includes('approved_faq')) parts.push('approved_answer');
      if (answerByModel) parts.push('model');
    }
    const modelWrote = !!modelResponse?.text.trim();
    let modelText: ModelTextOutcome =
      modelWrote || answerByModel ? 'used' : answerUnsafe ? 'unsafe' : 'none';
    if (matchedRule?.action === 'handoff') next.mode = 'human';
    let configuredResponseUsed = false;
    if (allergyQuestion) {
      // The engine's own lines (cart facts, a review, a refusal) stay. Then the owner's approved
      // allergy answer word for word, or a fixed notice and a person: AI wording, and owner text
      // written for something else, never vouch for what a dish contains.
      const approved = approvedAllergyAnswer(company, input.menuLink);
      const kept = transactional || protectedReply ? reply : '';
      const answer = approved ?? allergyNotice(company, lang);
      reply = [
        kept,
        kept.includes(answer) ? '' : answer,
        approved ? incompleteReviewQuestion : undefined,
      ]
        .filter(Boolean)
        .join('\n\n');
      parts = [...(kept ? ['engine' as const] : []), approved ? 'approved_answer' : 'engine'];
      if (approved && !traces.includes('approved_faq')) traces.push('approved_faq');
      if (!approved) {
        next.mode = 'human';
        delete next.botPausedAt;
        delete next.limitPause;
        if (!traces.includes('handoff')) traces.push('handoff');
      }
      traces.push('allergy_question_guarded');
      if (modelWrote || answerByModel) modelText = 'protected';
      configuredResponseUsed = true;
    } else if (!protectedReply && exactResponse) {
      parts = transactional && reply ? [...parts, 'exact_rule'] : ['exact_rule'];
      if (modelWrote) modelText = 'exact_rule';
      reply = transactional && reply ? `${reply}\n\n${exactResponse}` : exactResponse;
      configuredResponseUsed = true;
    } else if (
      !protectedReply &&
      next.mode === 'bot' &&
      grounded &&
      (validAskFor || (!reply && harmlessAskFor)) &&
      modelResponse?.text.trim() &&
      !unsafe(modelResponse.text)
    ) {
      const modelFirst =
        traces.includes('menu') ||
        traces.includes('clarify_item') ||
        traces.includes('deal_choice_asked');
      parts =
        transactional && reply
          ? modelFirst
            ? ['model', ...parts]
            : [...parts, 'model']
          : ['model'];
      reply =
        transactional && reply
          ? modelFirst
            ? `${modelResponse.text.trim()}\n\n${reply}`
            : `${reply}\n\n${modelResponse.text.trim()}`
          : modelResponse.text.trim();
      configuredResponseUsed = true;
    } else if (modelWrote) {
      modelText = protectedReply
        ? 'protected'
        : next.mode !== 'bot'
          ? 'staff_mode'
          : !grounded
            ? 'ungrounded'
            : !validAskFor
              ? 'invalid_question'
              : 'unsafe';
    }
    if (incompleteReviewQuestion && !configuredResponseUsed) {
      reply = `${reply}\n\n${incompleteReviewQuestion}`;
      if (!parts.includes('engine')) parts.push('engine');
    }
    // The menu page link once: the engine's link line goes when the AI's intro or the rule's
    // wording already shares it.
    if (input.menuLink) {
      const once = reply.replace(`\n\n${menuLinkLine(lang, input.menuLink)}`, '');
      if (once !== reply && hasMenuLink(once, input.menuLink)) reply = once;
    }
    if (modelResponse && !grounded) traces.push('invalid_model_grounding_ignored');
    if (modelResponse?.text && claims(modelResponse.text))
      traces.push('unsafe_model_response_ignored');
    else if (modelResponse?.text && assures(modelResponse.text))
      traces.push('allergy_assurance_ignored');
    else if (modelResponse?.text && invents(modelResponse.text))
      traces.push('invented_link_ignored');
    if (modelResponse?.askFor && !validAskFor && !parts.includes('model'))
      traces.push('invalid_model_prompt_ignored');
    if (!reply && traces.includes('answer') && !answerOnlyLabelSlip) {
      next.mode = 'human';
      traces.push('handoff');
      parts = [handoffMessage ? 'handoff_message' : 'engine'];
      reply =
        handoffMessage ||
        say(
          lang,
          'I’m not certain about that, so I’ve asked a staff member to help.',
          'مجھے اس بارے میں یقین نہیں، اس لیے عملے سے مدد مانگی ہے۔',
          'Mujhe is baat ka yaqeen nahi, is liye staff se madad mangi hai.',
        );
    }
    const fallback = () => {
      reply =
        missingDetails(company, cart, lang) ??
        say(
          lang,
          'Your details are saved. Ask to review the order when you are ready.',
          'آپ کی تفصیلات محفوظ ہیں۔ تیار ہوں تو آرڈر کا جائزہ مانگیں۔',
          'Aap ki details save hain. Tayyar hon to order review karne ko kahein.',
        );
      traces.push('response_fallback');
      parts = ['fallback'];
    };
    if (!reply && next.mode === 'bot') fallback();
    if (traces.includes('handoff') && handoffMessage && !exactResponse && !allergyQuestion) {
      reply = handoffMessage;
      parts = ['handoff_message'];
    }
    if (
      company.bot?.published &&
      reply &&
      !matchedRule &&
      !protectedReply &&
      !allergyQuestion &&
      next.mode === 'bot'
    ) {
      const greeting = fillMenuLink(configuration.greeting ?? '', input.menuLink);
      if (/^(hi|hello|salam|سلام|ہیلو)$/iu.test(input.text.trim()) && greeting) {
        reply = greeting;
        parts = ['greeting'];
      }
    }
    // Any placeholder left in other wording; a bot reply it empties takes the fallback above.
    if (reply) reply = fillMenuLink(reply, input.menuLink);
    if (!reply && next.mode === 'bot') fallback();
    // A request for the menu carries the menu page link, however the bot answered it, unless
    // there is nothing on the menu to show. The owner's exact wording (a rule or an approved
    // answer) stays exact: they can write {menu_link} in it instead.
    if (
      input.menuLink &&
      reply &&
      next.mode === 'bot' &&
      !parts.includes('exact_rule') &&
      !parts.includes('approved_answer') &&
      !allergyQuestion &&
      asksForMenu(input.text) &&
      !hasMenuLink(reply, input.menuLink) &&
      products.some((product) => product.companyId === company.id)
    ) {
      reply = `${reply}\n\n${menuLinkLine(lang, input.menuLink)}`;
      if (!parts.includes('engine')) parts.push('engine');
    }
    // A closed restaurant says so early, in its first reply while closed, not only once the
    // customer reaches the review: before the reply, or after the owner's greeting, which opens
    // the chat. The owner's exact wording and an allergy answer stay as they are, and a customer
    // asking about a placed order needs no notice. A late message is answered for now.
    if (
      reply &&
      next.mode === 'bot' &&
      !allergyQuestion &&
      !parts.includes('exact_rule') &&
      !parts.includes('approved_answer') &&
      !traces.includes('order_status') &&
      cart.status !== 'submitted' &&
      !isOpen(company, shownAt) &&
      !CLOSED_LEADS.some((lead) => reply.includes(lead)) &&
      !conversation.messages.some(
        (m) =>
          m.role === 'assistant' &&
          Date.parse(input.now) - Date.parse(m.createdAt) < CLOSED_NOTICE_MS &&
          CLOSED_LEADS.some((lead) => m.text.includes(lead)),
      )
    ) {
      // A cancelled cart is not saved, so it is not promised.
      const notice =
        cart.status === 'cancelled'
          ? closedText(company, lang, shownAt)
          : `${closedText(company, lang, shownAt)} ${say(
              lang,
              'You can still look at the menu and add items; your cart will be saved.',
              'آپ پھر بھی مینو دیکھ کر چیزیں شامل کر سکتے ہیں، آپ کی ٹوکری محفوظ رہے گی۔',
              'Aap phir bhi menu dekh kar items add kar sakte hain, cart save rahega.',
            )}`;
      if (parts.includes('greeting')) {
        reply = `${reply}\n\n${notice}`;
        if (!parts.includes('engine')) parts.push('engine');
      } else {
        reply = `${notice}\n\n${reply}`;
        if (!parts.includes('engine')) parts.unshift('engine');
      }
      traces.push('closed_notice');
    }
    if (modelText === 'used' && !parts.includes('model')) modelText = 'replaced';
    // WhatsApp sends the Confirm buttons only with a message of up to 1024 characters: what
    // deals include goes when the whole reply (a lead line before the review, say) passes that.
    if (
      deals.length &&
      shownReview &&
      cart.status === 'awaiting_confirmation' &&
      reply.length > 1024 &&
      reply.includes(shownReview)
    ) {
      const plain = review(company, products, cart, lang, shownAt, false);
      if (plain !== shownReview) {
        reply = reply.replace(shownReview, () => plain);
        shownReview = plain;
      }
    }
    // Confirmation counts only against the reply that showed the review. A review the final
    // reply does not carry (replaced by a handoff or an error) was never seen: not confirmable.
    if (shownReview && cart.status === 'awaiting_confirmation') {
      if (reply.includes(shownReview)) {
        cart.reviewMessageId = `${input.messageId}:reply`;
        cart.reviewedAt = shownAt;
      } else unreview(cart);
    }
    if (reply)
      next.messages.push({
        id: `${input.messageId}:reply`,
        role: 'assistant',
        text: reply,
        createdAt: input.now,
      });
    if (cart.customerName) next.customerName = cart.customerName;
    const decision: ReplyDecision = {
      parts: reply ? [...new Set<ReplyPart>(parts.length ? parts : ['engine'])] : [],
      modelText,
      ...(matchedRule && {
        matchedRule: {
          id: matchedRule.id,
          when: matchedRule.when.slice(0, 200),
          action: matchedRule.action,
          responseMode: matchedRule.responseMode,
        },
      }),
      corrections: [
        ...(recapCorrected ? ['recap_shown'] : []),
        ...(tooManyActions ? ['too_many_actions'] : []),
        ...(answerUnsafe && !traces.includes(answerUnsafeTrace) ? [answerUnsafeTrace] : []),
        ...traces.filter(
          (trace) => CORRECTION_TRACES.has(trace) || trace.startsWith('validation_failed:'),
        ),
      ],
    };
    return { conversation: next, order, reply, traces, decision };
  };
  if (next.mode === 'human' || !company.botEnabled) {
    // While the bot is off, staff alerts and "Needs staff" pick the chat up (they follow
    // mode 'human'). The mark lets the bot take it back once it is switched on again
    // (see resumesAfterPause), unless the customer asked for a person.
    if (next.mode === 'bot') next.botPausedAt = input.now;
    next.mode = 'human';
    // Asking for a person makes it a real handoff: the bot must not take the chat back. Orderly's
    // own marker ("… Staff assistance requested.") is not the customer asking.
    if (
      input.action?.type === 'handoff' ||
      (!ORDERLY_MARKER.test(input.text.trim()) && asksForPerson(input.text, deals))
    ) {
      delete next.botPausedAt;
      delete next.limitPause;
    }
    traces.push('human_mode_message_saved');
    return finish();
  }
  // "Where is my order?" about the order this chat placed: the engine states its real status,
  // never the AI, whatever the AI proposed. "How long" wording only while the order is current.
  if (
    !input.action &&
    input.latestOrder &&
    cart.orderId &&
    (cart.status === 'submitted' || cart.status === 'cancelled') &&
    asksOrderStatus(input.text, input.latestOrder, input.now)
  ) {
    traces.push('order_status');
    reply = orderStatusText(lang, input.latestOrder, shownAt);
    return finish();
  }
  let requested = input.action
    ? [input.action]
    : (actions ?? parseActions(company, products, next, input.text));
  // A recap is a read, not a checkout attempt. Correct a model that only repeats
  // the next form question, while leaving explicit owner rules/handoffs intact.
  if (
    !input.action &&
    isCartSummaryRequest(input.text) &&
    !configuration.behaviorRules.some(
      (rule) => rule.enabled && rule.id === modelResponse?.matchedRuleId,
    ) &&
    requested.every((action) => ['answer', 'review', 'cart_summary'].includes(action.type))
  ) {
    recapCorrected = requested.some((action) => action.type !== 'cart_summary');
    requested = [{ type: 'cart_summary' }];
  }
  // The AI's actions about deals stand: the engine checks them only as it runs them (a deal not on
  // is refused, a missing or unknown pick is asked, the count is bounded), and its own reading of
  // the deals never takes their place, drops them or changes their count.
  const isDeal = (id: string) => deals.some((deal) => deal.id === id);
  const aboutDeal = (action: BotAction) =>
    ((action.type === 'add_item' || action.type === 'remove_item') && isDeal(action.productId)) ||
    (action.type === 'clarify_item' && action.candidateProductIds.some(isDeal));
  // A dish named by one of these options ("Sprite 345ml" by a deal's Sprite).
  const namedBy = (id: string, options: string[]) => {
    const product = products.find((p) => p.companyId === company.id && p.id === id);
    return (
      !!product &&
      !product.deal &&
      options.some((option) =>
        [product.name, ...product.aliases].some(
          (label) => contains(label, option) || contains(option, label),
        ),
      )
    );
  };
  let parsed: BotAction[] | undefined;
  const parse = () => (parsed ??= parseActions(company, products, next, input.text));
  const pendingDeal = conversation.pendingDealChoice;
  const askedDeal = pendingDeal && deals.find((deal) => deal.id === pendingDeal.productId);
  if (!input.action && actions && pendingDeal && askedDeal) {
    const [answer] = parse();
    const asked = openChoice(askedDeal, pendingDeal.picked);
    // A message that is only one option of the choice asked, by its name or its number ("sprite",
    // "2", "sprite wala please"): the AI's add of a dish of that name, its "which one?" about
    // those, or no change to the cart at all, is the deal's answer, unless the AI gave that
    // answer itself.
    const said = normalizeCatalogText(input.text)
      .split(' ')
      .filter((word) => word && !ANSWER_WORDS.has(word))
      .join(' ');
    if (
      asked &&
      (/^\d{1,2}(?:st|nd|rd|th)?$/u.test(said) ||
        asked.options.some((option) => normalizeCatalogText(option.name) === said)) &&
      answer?.type === 'add_item' &&
      answer.productId === askedDeal.id
    ) {
      const picked = asked.options
        .filter((option) => answer.modifierIds?.includes(option.id))
        .map((option) => option.name);
      const separate = (action: BotAction) =>
        (action.type === 'add_item' && namedBy(action.productId, picked)) ||
        (action.type === 'clarify_item' &&
          action.candidateProductIds.every((id) => namedBy(id, picked)));
      const answered = requested.some(
        (action) => action.type === 'add_item' && action.productId === askedDeal.id,
      );
      if (
        requested.some(separate) ||
        !requested.some((action) =>
          ['add_item', 'remove_item', 'clarify_item'].includes(action.type),
        )
      ) {
        requested = [
          ...(answered ? [] : [answer]),
          ...requested.filter((action) => !separate(action)),
        ];
        correctedInterpretation = true;
        traces.push('deal_choice_resolved');
      }
    } else if (
      answer?.type === 'remove_item' &&
      answer.productId === askedDeal.id &&
      !requested.some(aboutDeal)
    )
      // The deal turned down ("deal 1 nahi chahiye", "nahi rehne do") and the AI proposing nothing
      // about deals: its question is over, so a later "sprite" is the drink.
      requested = [...requested, answer];
  }
  if (
    !input.action &&
    actions &&
    requested.some((action) => action.type === 'add_item' || action.type === 'clarify_item')
  ) {
    // With deals, the parser's reading of them is set aside, and so are the dishes it read from an
    // option the AI picked for a deal ("sprite" in "sprite wala"): the rest is weighed against the
    // AI's dishes as on a menu without deals. A question only about the deals shows them still.
    const picks = new Set(
      requested.flatMap((action) =>
        action.type === 'add_item' && isDeal(action.productId) ? (action.modifierIds ?? []) : [],
      ),
    );
    const options = deals
      .flatMap((deal) => deal.deal!.choices.flatMap((group) => group.options))
      .filter((option) => picks.has(option.id))
      .map((option) => option.name);
    const dishReading = (action: BotAction) =>
      !aboutDeal(action) &&
      !(
        action.type === 'menu' &&
        (action.query === 'deals'
          ? !asksOnlyAboutDeals(input.text)
          : deals.some((deal) => deal.name === action.query))
      ) &&
      !(action.type === 'add_item' && namedBy(action.productId, options)) &&
      !(
        action.type === 'clarify_item' &&
        action.candidateProductIds.every((id) => namedBy(id, options))
      );
    const deterministic = deals.length ? parse().filter(dishReading) : parse();
    const first = deterministic[0];
    // A dish's count is read as the parser reads dishes: with the deals named taken out, so the
    // 4 of "4 zinger deal, aur ek zinger burger" is never the burger's.
    const dishText = deals.length
      ? dishTextOf(
          input.text,
          products.filter((product) => product.companyId === company.id && !product.deal),
          findDealMentions(products, company.id, normalize(input.text)).flatMap(
            (mention) => mention.spans,
          ),
        )
      : input.text;
    if (first?.type === 'clarify_item' && requested.some((action) => action.type === 'add_item')) {
      // The dish to choose is asked about. The AI's additions of other dishes stand ("karahi 4
      // naan" with two karahis: the naan), added first so the choice stays open. A count that
      // may be the next dish's (the 4) is not the choice's: the AI's count for it, else 1.
      const choice = new Set(first.candidateProductIds);
      const others = requested.filter(
        (action) =>
          (action.type === 'add_item' && !choice.has(action.productId)) || aboutDeal(action),
      );
      const between = products.some(
        (product) =>
          choice.has(product.id) &&
          quantityNear(product, dishText, products) !== undefined &&
          clearQuantityNear(product, dishText, products) === undefined,
      );
      const proposed = requested.find((action) =>
        action.type === 'add_item'
          ? choice.has(action.productId)
          : action.type === 'clarify_item' &&
            action.candidateProductIds.some((id) => choice.has(id)),
      );
      const count =
        proposed?.type === 'add_item' || proposed?.type === 'clarify_item' ? proposed.quantity : 1;
      requested = [...others, between ? { ...first, quantity: count } : first];
      correctedInterpretation = true;
      traces.push('ambiguous_addition_prevented');
    } else if (
      first?.type === 'add_item' &&
      deterministic.length === 1 &&
      (requested.some((action) => action.type === 'clarify_item' && !aboutDeal(action)) ||
        next.pendingItemChoice)
    ) {
      // A specific name/ordinal resolves the outstanding choice; keep its options and quantity.
      // The count: one written next to the dish in its own part (the parser's); else the AI's
      // when the customer wrote that number ("chicken biryani, make it 3"); else the pending
      // choice's, so an AI that forgot "2 chicken" still adds 2, and "aur 3 naan", "naan 3,
      // chicken wali" or "chicken wali 4 naan" stays the naan's.
      const pending = next.pendingItemChoice?.candidateProductIds.includes(first.productId)
        ? next.pendingItemChoice
        : undefined;
      const product = products.find((p) => p.id === first.productId);
      const explicit = !!product && clearQuantityNear(product, dishText, products) !== undefined;
      const quantityFor = (proposed: number) =>
        !pending || explicit
          ? first.quantity
          : proposed === pending.quantity || mentionsQuantity(input.text, proposed, products)
            ? proposed
            : first.quantity;
      requested = requested.map((action) => {
        if (action.type === 'clarify_item' && !aboutDeal(action))
          return { ...first, quantity: quantityFor(action.quantity) };
        if (action.type === 'add_item' && action.productId === first.productId)
          return {
            ...first,
            quantity: quantityFor(action.quantity),
            variantId: action.variantId ?? first.variantId,
            modifierIds: action.modifierIds?.length ? action.modifierIds : first.modifierIds,
            notes: action.notes?.trim() ? action.notes : first.notes,
          };
        return action;
      });
      if (actions.some((action) => action.type === 'clarify_item' && !aboutDeal(action)))
        correctedInterpretation = true;
      traces.push('item_choice_resolved');
    } else if (
      first?.type === 'menu' &&
      requested.some((action) => action.type === 'add_item' || action.type === 'clarify_item')
    ) {
      // Browsing: the menu in place of the AI's dish changes. What it proposed about deals stands.
      const kept = requested.filter(aboutDeal);
      const undone = requested.some(
        (action) =>
          (action.type === 'add_item' || action.type === 'clarify_item') && !kept.includes(action),
      );
      requested = [...deterministic, ...kept];
      if (undone) {
        correctedInterpretation = true;
        traces.push('browse_cart_mutation_prevented');
      }
    }
  }
  if (requested.length > 8) {
    tooManyActions = true;
    reply = say(
      lang,
      'Please split this into a smaller request, or ask for staff.',
      'درخواست کو چھوٹے حصوں میں بھیجیں یا عملے سے بات کریں۔',
      'Request choti kar ke bhejein, ya staff se baat karein.',
    );
    return finish();
  }
  // Deals' choices follow ONE rule, settled once every action of the turn has run (see
  // settleDealChoice below), so the order the AI lists its actions in changes nothing:
  // - One question is open at a time. A dish's "which one?" goes first; a deal missing a choice
  //   waits behind it (`queued`: both open before this turn) and is asked once that is over.
  // - `openBefore` is the deal whose choice was open before this turn. Which adds of that deal
  //   answer it is decided before any runs: one naming any of its options answers it; with
  //   none, one naming no option restates it (its count, its notes). Those adds, up to the
  //   count asked, share its earlier picks and notes ("ek pepsi aur ek 7up" for 2 split it);
  //   once one is added in full its question is over and never asked again. Beside an answer,
  //   an add naming no option, or one beyond the count asked, is one more of that deal.
  // - Deals added this turn without every choice wait in `missing`, in order. The deal open
  //   before goes first; the first of these is asked after it, and the rest are not added
  //   ("Then tell me the next deal.", said when that question is asked, even turns later if it
  //   waits behind a dish's "which one?": `more`).
  // - A deal asked before this turn and passed over for something else is set aside, so a
  //   later "pepsi" is the drink. One that waited and was never asked is never set aside.
  const queued = !!conversation.pendingItemChoice && !!next.pendingDealChoice;
  let openBefore = next.pendingDealChoice;
  const openOptions = new Set(
    deals
      .find((deal) => deal.id === openBefore?.productId)
      ?.deal?.choices.flatMap((group) => group.options.map((option) => option.id)),
  );
  const answersOpen = (action: BotAction) =>
    action.type === 'add_item' &&
    action.productId === openBefore?.productId &&
    !!action.modifierIds?.some((id) => openOptions.has(id));
  const openAnswered = requested.some(answersOpen);
  let openTaken = 0;
  const missing: NonNullable<Conversation['pendingDealChoice']>[] = [];
  let partlyAnswered = false;
  let added = false;
  const settleDealChoice = () => {
    let open = next.pendingDealChoice;
    if (open && !partlyAnswered && !queued && (added || missing.length)) open = undefined;
    // Its question is due when this turn left a choice to ask, or when the "which one?" a
    // waiting deal was queued behind is over (answered, or passed over by another addition).
    const due =
      partlyAnswered || missing.length > 0 || (!!open && queued && !next.pendingItemChoice);
    if (!due) {
      if (!open) {
        delete next.pendingDealChoice;
        // The deal that waited with others not added, now added in full: the note still goes.
        if (openBefore?.more && traces.includes('deal_choice_answered'))
          dealQuestion = nextDealNote(lang);
      }
      return;
    }
    const queue = [...(open ? [open] : []), ...missing];
    // A "which one?" asked this turn goes first: the deal waits, and is asked once that is over.
    const waits = traces.includes('clarify_item') && !!next.pendingItemChoice;
    let refusal = '';
    if (!waits && open && !partlyAnswered) {
      // The deal that waited is asked as it stands now: one paused, sold out or out of its times
      // since is refused instead, and one with no choice left open (the owner removed it) is
      // dropped.
      const { productId, picked } = open;
      const deal = deals.find((d) => d.id === productId);
      if (deal?.deal?.state !== 'on' || !openChoice(deal, picked)) {
        queue.shift();
        if (deal?.deal && deal.deal.state !== 'on') {
          refusal = dealRefusal(deal, lang, clock);
          traces.push('deal_not_on');
        }
      }
    }
    const [first, ...more] = queue;
    if (first) next.pendingDealChoice = first;
    else delete next.pendingDealChoice;
    let question = '';
    // Deals not added: the note goes with the question asked now, or with the deal that waits
    // behind a "which one?" until its question is asked.
    const noted = !!openBefore?.more || more.length > 0;
    if (first && waits && noted) first.more = true;
    if (first && !waits) {
      delete first.more;
      question = dealChoiceQuestion(
        deals.find((d) => d.id === first.productId)!,
        first,
        lang,
        noted,
      );
      if (!traces.includes('deal_choice_asked')) traces.push('deal_choice_asked');
      // One question at a time: a "which one?" left open from before is over.
      delete next.pendingItemChoice;
    }
    // A refused deal that waited with others not added: the note follows the refusal.
    const note = refusal && !first && noted ? nextDealNote(lang) : '';
    dealQuestion = [refusal, question, note].filter(Boolean).join('\n\n') || undefined;
  };
  for (const action of requested) {
    traces.push(action.type);
    try {
      if (action.type === 'handoff') {
        next.mode = 'human';
        delete next.botPausedAt;
        delete next.limitPause;
        reply = say(
          lang,
          'This conversation is now assigned to staff. The bot is paused until they resume it.',
          'یہ گفتگو اب عملے کے پاس ہے۔ بوٹ روک دیا گیا ہے۔',
          'Yeh conversation ab staff ke paas hai. Bot pause kar diya gaya hai.',
        );
        if (handoffMessage) reply = handoffMessage;
        break;
      }
      if (action.type === 'clarify_item') {
        const candidates = action.candidateProductIds
          .map((id) =>
            products.find((product) => product.companyId === company.id && product.id === id),
          )
          .filter((product): product is Product => Boolean(product));
        if (candidates.length < 2) throw new Error('That menu choice is no longer available.');
        // A step towards adding to a cancelled cart: no AI wording promising the dish.
        if (cart.status === 'cancelled') cancelledCartRefused = true;
        next.pendingItemChoice = {
          candidateProductIds: candidates.map((product) => product.id),
          quantity: action.quantity,
          requestedOptionNames: action.requestedOptionNames ?? [],
          notes: action.notes ?? '',
          originalText: action.originalText ?? input.text,
        };
        // Deals told apart by price, and by when they are on if not now.
        const unavailable = (product: Product) => {
          if (!product.deal)
            return product.available
              ? ''
              : say(lang, ' · Unavailable', ' · دستیاب نہیں', ' · available nahi');
          const when = product.deal.state === 'later' ? dealTimes(product, lang, clock) : '';
          return ` — ${money(product.price)}${
            when
              ? say(lang, ` · on ${when}`, ` · ${when} دستیاب`, ` · ${when} available`)
              : product.deal.state === 'sold_out'
                ? say(lang, ' · sold out', ' · سامان ختم', ' · sold out')
                : product.available
                  ? ''
                  : say(lang, ' · Unavailable', ' · دستیاب نہیں', ' · available nahi')
          }`;
        };
        reply = `${say(lang, 'Which one would you like?', 'آپ کون سا لینا چاہیں گے؟', 'Aap kaun sa lena chahenge?')}\n${candidates
          .map((product, index) => `${index + 1}. ${product.name}${unavailable(product)}`)
          .join('\n')}`;
        continue;
      }
      if (action.type === 'menu') {
        reply = menu(
          company,
          products,
          lang,
          action.query,
          !!modelResponse,
          input.menuLink,
          shownAt,
        );
        continue;
      }
      if (action.type === 'cart_summary') {
        // A deal that isn't on now is marked, with how to take it out.
        const problem = dealProblem(company, products, cart, lang, clock);
        if (problem) traces.push('deal_not_on');
        reply = cartSummary(company, products, cart, lang, problem);
        continue;
      }
      if (action.type === 'new_order') {
        startNewCart(cart);
        delete next.pendingItemChoice;
        delete next.pendingDealChoice;
        openBefore = undefined;
        missing.length = 0;
        reply = say(
          lang,
          'Started a new cart. What would you like?',
          'نئی ٹوکری تیار ہے۔ آپ کیا پسند کریں گے؟',
          'Naya cart tayyar hai. Aap kya lena chahenge?',
        );
        continue;
      }
      if (action.type === 'cancel') {
        delete next.pendingItemChoice;
        delete next.pendingDealChoice;
        openBefore = undefined;
        missing.length = 0;
        if (cart.status === 'submitted') {
          traces.push(`cancel_submitted:${cart.orderId}`);
          next.mode = 'human';
          reply = say(
            lang,
            'Your cancellation request has been passed to staff. They will check the order status before cancelling.',
            'منسوخی کی درخواست عملے کے پاس ہے۔ وہ آرڈر کی حالت دیکھ کر بتائیں گے۔',
            'Cancellation ki request staff ke paas hai. Woh order status check kar ke batayenge.',
          );
        } else {
          cart.status = 'cancelled';
          cart.items = [];
          invalidate(cart);
          cart.status = 'cancelled';
          reply = say(
            lang,
            'Your cart has been cancelled. Send “new order” to start again.',
            'ٹوکری منسوخ کر دی گئی ہے۔ دوبارہ شروع کرنے کے لیے “نیا آرڈر” لکھیں۔',
            'Cart cancel kar diya gaya hai. Dobara shuru karne ke liye “new order” likhein.',
          );
        }
        continue;
      }
      if (action.type === 'answer') {
        const matched = company.faqs.find(
          (f) =>
            normalize(input.text).includes(normalize(f.question)) ||
            (action.text === f.answer && f.answer.trim()),
        );
        // An approved answer that was only the menu page link, while the page is off, is none.
        const approved = matched && fillMenuLink(matched.answer, input.menuLink);
        const faq = matched && (approved || !matched.answer.trim()) ? matched : undefined;
        const proposed = fillMenuLink(action.text, input.menuLink).trim();
        const unsafeClaim = unsafe(proposed);
        if (modelResponse && !modelResponse.text.trim() && proposed && !unsafeClaim)
          modelResponse = { ...modelResponse, text: proposed };
        // Structured response metadata is validated in finish before deciding
        // whether a handoff is needed. An empty answer action is not a failure.
        reply = faq ? (approved ?? '') : modelResponse || unsafeClaim ? '' : proposed;
        // Explanation only: an answer the model wrote without a separate response object.
        if (!faq && !modelResponse && actions && !input.action && proposed) {
          if (unsafeClaim) {
            answerUnsafe = true;
            if (!claims(proposed))
              answerUnsafeTrace = assures(proposed)
                ? 'allergy_assurance_ignored'
                : 'invented_link_ignored';
          } else modelAnswer = proposed;
        }
        traces.push(faq ? 'approved_faq' : 'grounded_model_answer');
        continue;
      }
      // An order staff never closed no longer holds the cart: the returning customer's new
      // order starts a fresh cart, as "new order" would. The order itself is left as it is.
      if (
        cart.status === 'submitted' &&
        cart.orderId &&
        input.latestOrder &&
        orderLeftOpen(input.latestOrder, shownAt)
      ) {
        startNewCart(cart);
        delete next.pendingItemChoice;
        delete next.pendingDealChoice;
        openBefore = undefined;
        missing.length = 0;
        traces.push('new_order');
      }
      if (cart.status === 'submitted') {
        reply = say(
          lang,
          'This order has already been submitted. Ask “where is my order?” for its status, or send “new order” to start another.',
          'یہ آرڈر پہلے بھیجا جا چکا ہے۔ اس کی حالت جاننے کے لیے “میرا آرڈر کہاں ہے؟” لکھیں، یا نیا آرڈر شروع کرنے کے لیے “نیا آرڈر” لکھیں۔',
          'Yeh order pehle submit ho chuka hai. Status ke liye “mera order kahan hai?” likhein, ya “new order” likhein.',
        );
        traces.push('duplicate_submission_prevented');
        continue;
      }
      if (cart.status === 'cancelled') {
        cancelledCartRefused = true;
        reply = say(
          lang,
          'Send “new order” to start a fresh cart.',
          'نئی ٹوکری کے لیے “نیا آرڈر” لکھیں۔',
          'Naye cart ke liye “new order” likhein.',
        );
        continue;
      }
      if (action.type === 'add_item') {
        const product = products.find(
          (p) => p.id === action.productId && p.companyId === company.id,
        );
        // The deal whose choice was open before this turn, wherever this add comes in the turn
        // (see openBefore): an add answering it, or restating it, within the count asked, takes
        // on its earlier picks and notes. The count is the action's own.
        const ofOpen =
          !!product?.deal &&
          product.id === openBefore?.productId &&
          (!openAnswered || answersOpen(action));
        const pending = ofOpen && openTaken < openBefore!.quantity ? openBefore : undefined;
        if (ofOpen) openTaken += Number.isInteger(action.quantity) ? action.quantity : 0;
        let add = action;
        if (product?.deal) {
          if (product.deal.state !== 'on') {
            // Its open choice goes with the refusal (kept, since `next` is not rolled back), so
            // the next "sprite" is the Sprite drink, never this deal when it is back on.
            if (next.pendingDealChoice?.productId === product.id) delete next.pendingDealChoice;
            traces.push('deal_not_on');
            throw new Error(dealRefusal(product, lang, clock));
          }
          // One pick per choice; an unknown id, or two from one choice, is asked again.
          const ids = action.modifierIds ?? [];
          const picks = product.deal.choices.flatMap((group) => {
            const named = group.options.filter((option) => ids.includes(option.id));
            if (named.length) return named.length === 1 ? [named[0]!.id] : [];
            const earlier = group.options.find((option) => pending?.picked.includes(option.id));
            return earlier ? [earlier.id] : [];
          });
          add = {
            ...action,
            modifierIds: picks,
            notes: action.notes?.trim() ? action.notes : (pending?.notes ?? action.notes),
          };
          if (picks.length < product.deal.choices.length) {
            if (!Number.isInteger(add.quantity) || add.quantity < 1 || add.quantity > 50)
              throw new Error('Choose a quantity between 1 and 50.');
            // A deal in the cart that isn't on is named first.
            dealsOn();
            const open = {
              productId: product.id,
              quantity: add.quantity,
              picked: [...picks].sort(),
              notes: (add.notes ?? '').slice(0, 300),
            };
            // The deal open before, partly answered, stays open with its next choice (one line
            // of it: a second waits too); another waits its turn. Which is asked is settled once
            // every action has run.
            if (pending && !partlyAnswered) {
              next.pendingDealChoice = open;
              partlyAnswered = true;
            } else missing.push(open);
            // The "which one?" this deal answered is over, so a number now answers the deal's
            // choice. A dish choice asked earlier this turn stays: it is asked first.
            if (
              !traces.includes('clarify_item') &&
              next.pendingItemChoice?.candidateProductIds.includes(product.id)
            )
              delete next.pendingItemChoice;
            if (!traces.includes('deal_choice_asked')) traces.push('deal_choice_asked');
            continue;
          }
        }
        if (!Number.isInteger(add.quantity) || add.quantity < 1 || add.quantity > 50)
          throw new Error('Choose a quantity between 1 and 50.');
        // A deal in the cart that isn't on is named, never priced into a general error.
        dealsOn();
        const trial: Cart = structuredClone(cart);
        const line = {
          productId: add.productId,
          quantity: add.quantity,
          variantId: add.variantId,
          modifierIds: [...(add.modifierIds ?? [])].sort(),
          notes: (add.notes ?? '').slice(0, 300),
        };
        const same = trial.items.find(
          (i) =>
            i.productId === line.productId &&
            i.variantId === line.variantId &&
            JSON.stringify([...i.modifierIds].sort()) === JSON.stringify(line.modifierIds) &&
            i.notes === line.notes,
        );
        if (same) same.quantity += line.quantity;
        else trial.items.push(line);
        // Validate all lines without requiring delivery details during cart building.
        const quote = quoteCart(company, products, { ...trial, fulfillment: 'pickup' });
        cart.items = trial.items;
        added = true;
        // The deal choice open before this turn is answered in full: over, never asked again. A
        // line of it still open (restated above, partly answered) stays.
        if (pending) {
          if (next.pendingDealChoice === openBefore) delete next.pendingDealChoice;
          if (!traces.includes('deal_choice_answered')) traces.push('deal_choice_answered');
        }
        delete next.pendingItemChoice;
        invalidate(cart);
        settleFulfillment();
        const quoted = quote.items[same ? trial.items.indexOf(same) : trial.items.length - 1]!;
        // A deal's picks are said back in every language ("Deal 1 (Drink: Sprite)"). A dish's
        // options are said as before deals: in English only, with the AI.
        const name = `${product!.name}${quoted.includes && quoted.variant ? ` (${quoted.variant})` : ''}`;
        if (modelResponse) {
          cartFacts.push(
            say(
              lang,
              `Added ${add.quantity} × ${product!.name}${quoted.variant ? ` (${quoted.variant})` : ''}${quoted.modifiers.length ? ` + ${quoted.modifiers.join(', ')}` : ''} — ${money(quoted.unitPrice)} each.${line.notes ? ` Notes: ${line.notes}` : ''}`,
              `${add.quantity} × ${name} شامل کر دیا — فی عدد ${money(quoted.unitPrice)}۔`,
              `${add.quantity} × ${name} add kar diya — ${money(quoted.unitPrice)} each.`,
            ),
          );
        } else {
          reply = say(
            lang,
            `Added ${add.quantity} × ${name}. Add anything else, or send “review”.`,
            `${add.quantity} × ${name} شامل کر دیا۔ مزید چیز بتائیں یا “جائزہ” لکھیں۔`,
            `${add.quantity} × ${name} add kar diya. Aur kuch chahiye, ya “review” likhein.`,
          );
        }
        continue;
      }
      if (action.type === 'remove_item') {
        // The deal whose choice is asked, turned down or taken off: it is not added, and its
        // question is over, so a later "sprite" is the drink. One already in the cart stays. So
        // is one asked before this turn that an add beside it passes over ("no deal, only
        // pepsi"), and one this turn added without its choices.
        const declined = [next.pendingDealChoice, conversation.pendingDealChoice, ...missing].some(
          (pending) => pending?.productId === action.productId,
        )
          ? deals.find((deal) => deal.id === action.productId)
          : undefined;
        if (declined) {
          if (next.pendingDealChoice?.productId === declined.id) delete next.pendingDealChoice;
          if (openBefore?.productId === declined.id) openBefore = undefined;
          for (let k = missing.length - 1; k >= 0; k--)
            if (missing[k]!.productId === declined.id) missing.splice(k, 1);
          const name = declined.name;
          const kept = cart.items.some((item) => item.productId === declined.id);
          reply = say(
            lang,
            `Okay, ${name} is not added.${kept ? ` The ${name} already in your cart stays: send “remove ${name}” to take it out.` : ''}`,
            `ٹھیک ہے، ${name} شامل نہیں کیا۔${kept ? ` ٹوکری میں پہلے سے موجود ${name} رہے گا: اسے نکالنے کے لیے “remove ${name}” لکھیں۔` : ''}`,
            `Theek hai, ${name} add nahi kiya.${kept ? ` Cart mein pehle se mojood ${name} rahega: nikalne ke liye “remove ${name}” likhein.` : ''}`,
          );
          continue;
        }
        const remaining = cart.items.filter((i) => i.productId !== action.productId);
        if (remaining.length === cart.items.length)
          throw new Error('That item is not in your cart.');
        cart.items = remaining;
        invalidate(cart);
        reply = say(
          lang,
          'Removed that item. Send “review” to see your cart.',
          'یہ چیز نکال دی۔ ٹوکری دیکھنے کے لیے “جائزہ” لکھیں۔',
          'Item hata diya. Cart dekhne ke liye “review” likhein.',
        );
        continue;
      }
      if (action.type === 'set_details') {
        const details = structuredClone(cart);
        const before = JSON.stringify([
          cart.fulfillment,
          cart.customerName,
          cart.address,
          cart.zone,
        ]);
        if (action.fulfillment && !['pickup', 'delivery'].includes(action.fulfillment))
          throw new Error('Choose pickup or delivery.');
        const refused = action.fulfillment && fulfillmentRefusal(company, action.fulfillment, lang);
        if (refused) throw new Error(refused);
        if (action.customerName !== undefined) {
          const name = action.customerName.trim();
          if (name.length < 2 || name.length > 80)
            throw new Error('Please give a name between 2 and 80 characters.');
          details.customerName = name;
        }
        if (action.address !== undefined) {
          const address = action.address.trim();
          if (address.length < 5 || address.length > 400)
            throw new Error('Please give a complete address between 5 and 400 characters.');
          details.address = address;
        }
        if (action.zone !== undefined) {
          const zone = company.deliveryZones.find(
            (z) => normalize(z.name) === normalize(action.zone!),
          );
          if (!zone) throw new Error(unknownZone(company, lang));
          details.zone = zone.name;
        }
        if (action.fulfillment) {
          details.fulfillment = action.fulfillment;
          if (action.fulfillment === 'pickup') {
            delete details.address;
            delete details.zone;
          }
        }
        if (!details.fulfillment && (offered === 'pickup' || offered === 'delivery'))
          details.fulfillment = offered;
        cart.customerName = details.customerName;
        cart.fulfillment = details.fulfillment;
        cart.address = details.address;
        cart.zone = details.zone;
        if (
          before !==
          JSON.stringify([details.fulfillment, details.customerName, details.address, details.zone])
        )
          invalidate(cart);
        if (!modelResponse) reply = missingDetails(company, cart, lang) ?? showReview();
        continue;
      }
      if (action.type === 'review') {
        settleFulfillment();
        const refused =
          cart.fulfillment && fulfillmentRefusal(company, cart.fulfillment, lang, true);
        if (refused) throw new Error(refused);
        dealsOn();
        incompleteReviewQuestion = modelResponse ? missingDetails(company, cart, lang) : undefined;
        reply = incompleteReviewQuestion
          ? cartSummary(company, products, cart, lang)
          : showReview();
        continue;
      }
      if (action.type === 'confirm') {
        settleFulfillment();
        const refused =
          cart.fulfillment && fulfillmentRefusal(company, cart.fulfillment, lang, true);
        if (refused) throw new Error(refused);
        // Typed words must be consent; a bare "yes" only straight after the review itself.
        const agreed = input.action ? 'explicit' : consent(input.text);
        if (!agreed || (agreed === 'bare' && !reviewAnswered)) {
          const prompt = say(
            lang,
            'Please review your order and explicitly reply “confirm” to submit it.',
            'آرڈر دیکھ کر بھیجنے کے لیے واضح طور پر “تصدیق” لکھیں۔',
            'Order review kar ke wazeh taur par “confirm” likhein.',
          );
          // The review again right below, so the next "confirm" places this order: it says how,
          // so the lead only says nothing was placed. While closed, the review itself says so.
          reply = !cart.items.length
            ? prompt
            : isOpen(company, shownAt)
              ? `${orderSafetyLine(lang, cart)}\n\n${showReview()}`
              : showReview();
          traces.push('unconfirmed_model_action_rejected');
          continue;
        }
        if (!isOpen(company, shownAt)) {
          reply =
            closedText(company, lang, shownAt) +
            say(lang, ' Your cart is saved.', ' آپ کی ٹوکری محفوظ ہے۔', ' Cart save hai.');
          // Nothing stays confirmable while closed; once open, "confirm" shows a fresh review.
          if (cart.status === 'awaiting_confirmation') unreview(cart);
          continue;
        }
        // Its deals are judged now, not when the review was shown.
        dealsOn();
        const missing = missingDetails(company, cart, lang);
        if (missing) {
          reply = missing;
          continue;
        }
        const quote = quoteCart(company, products, cart);
        // Consent counts against the latest review only: typed words must answer the review
        // message itself, and any confirmation must come within the hour and not arrive late.
        if (
          initialReview.status !== 'awaiting_confirmation' ||
          initialReview.revision !== cart.revision ||
          initialReview.hash !== quote.hash ||
          cart.reviewedRevision !== cart.revision ||
          cart.quoteHash !== quote.hash ||
          (action.revision !== undefined && action.revision !== cart.revision) ||
          (!input.action && !reviewAnswered) ||
          !reviewFresh ||
          input.late
        ) {
          traces.push('fresh_confirmation_required');
          const lead = input.late
            ? say(
                lang,
                'Sorry for the delay. Please confirm your order again.',
                'تاخیر کے لیے معذرت۔ براہ کرم اپنے آرڈر کی دوبارہ تصدیق کریں۔',
                'Der ke liye maazrat. Meherbani karke apna order dobara confirm karein.',
              )
            : say(
                lang,
                'Please confirm the current details below.',
                'نیچے دی گئی موجودہ تفصیل کی تصدیق کریں۔',
                'Neeche di gayi maujooda details confirm karein.',
              );
          reply = `${lead}\n\n${showReview()}`;
          continue;
        }
        const submissionKey = `${company.id}:${next.id}:${cart.revision}`;
        order = buildOrder(company, next, cart, quote, input.now, submissionKey);
        cart.status = 'submitted';
        cart.orderId = order.id;
        reply = orderReceivedText(lang, order, paymentMethods(company));
        traces.push('order_pending_restaurant_acceptance');
        break;
      }
    } catch (error) {
      reply = error instanceof Error ? error.message : 'Please ask staff for help.';
      traces.push(`validation_failed:${action.type}`);
      break;
    }
  }
  settleDealChoice();
  if (
    cartFacts.length &&
    cart.items.length &&
    !traces.some((trace) => trace.startsWith('validation_failed:'))
  ) {
    const quote = quoteCart(company, products, { ...cart, fulfillment: 'pickup' });
    cartFacts.push(
      say(
        lang,
        `Items subtotal: ${money(quote.subtotal)}.`,
        `اشیاء کی رقم: ${money(quote.subtotal)}۔`,
        `Items subtotal: ${money(quote.subtotal)}.`,
      ),
    );
  }
  return finish();
}

// The same steps as SQL set_order_status (202610200003_order_flow.sql). Accept is pending →
// preparing; 'accepted' is only an older order's current status. The dashboard takes a delivery
// order from preparing out for delivery (nextOrderStep); preparing → ready stays allowed for one,
// because a dashboard from before this flow, still open, offers only that (then ready → out for
// delivery).
const transitions: Record<OrderStatus, OrderStatus[]> = {
  pending: ['preparing', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'out_for_delivery', 'cancelled'],
  ready: ['out_for_delivery', 'completed', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
};
export function transitionOrder(order: Order, status: OrderStatus, now: string): Order {
  if (order.status === status) return structuredClone(order);
  if (!transitions[order.status]?.includes(status))
    throw new Error(`Cannot change ${order.status} to ${status}.`);
  if (status === 'out_for_delivery' && order.fulfillment !== 'delivery')
    throw new Error('Pickup orders cannot go out for delivery.');
  if (!Number.isFinite(new Date(now).getTime())) throw new Error('Invalid order timestamp.');
  return {
    ...structuredClone(order),
    status,
    updatedAt: now,
    syncStatus: order.syncStatus === 'not_connected' ? 'not_connected' : 'pending',
  };
}
