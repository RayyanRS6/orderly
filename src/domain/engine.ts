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
  clearQuantityNear,
  mentionsQuantity,
  quantityNear,
  quantityOfMention,
  resolveItemMention,
  resolvePendingItemChoice,
} from './menu-resolver';
import { leftToRight } from './disclosure';
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
export const asksForPerson = (text: string) =>
  /\b(human|staff|manager|person|insaan)\b|عملہ|انسان|مینیجر/u.test(normalize(text));
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
// Back to building without a cart change: nothing is confirmable until a review is shown again.
function unreview(cart: Cart) {
  cart.status = 'building';
  delete cart.reviewedRevision;
  delete cart.quoteHash;
  delete cart.quotedTotal;
  delete cart.reviewMessageId;
  delete cart.reviewedAt;
}

// The restaurant's local weekday (0 = Sunday) and minute of the day, or undefined.
function localClock(company: Company, now: string): { day: number; minute: number } | undefined {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: company.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
    const minute = Number(part('hour')) * 60 + Number(part('minute'));
    return day < 0 || !Number.isFinite(minute) ? undefined : { day, minute };
  } catch {
    return undefined;
  }
}
const toMinute = (time: string) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
};
export function isOpen(company: Company, now: string): boolean {
  try {
    const clock = localClock(company, now);
    if (!clock) return false;
    const { day, minute } = clock;
    const start = toMinute(company.openingHours.start),
      end = toMinute(company.openingHours.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return company.openingHours.days.includes(day);
    if (start < end)
      return company.openingHours.days.includes(day) && minute >= start && minute < end;
    return (
      (minute >= start && company.openingHours.days.includes(day)) ||
      (minute < end && company.openingHours.days.includes((day + 6) % 7))
    );
  } catch {
    return false;
  }
}
// When a closed restaurant next opens: in how many days (0 = today), on which weekday.
function nextOpening(company: Company, now: string): { inDays: number; day: number } | undefined {
  try {
    const clock = localClock(company, now);
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

/** Read-only recap: missing checkout details must never hide the customer's cart. */
function cartSummary(company: Company, products: Product[], cart: Cart, lang: Language): string {
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
        return `${item.quantity} × ${product?.name ?? 'Item no longer on the menu'}${product && !product.available ? ' · Unavailable' : ''}${item.notes ? `\n  ${item.notes}` : ''}`;
      })
      .join(
        '\n',
      )}\n\n${say(lang, 'Some selections need checking against the current menu before a total can be confirmed.', 'کل رقم بتانے سے پہلے کچھ اشیاء موجودہ مینو سے چیک کرنا ضروری ہیں۔', 'Total batane se pehle kuch items current menu se check karne honge.')}`;
  }
}

export function isCartSummaryRequest(text: string): boolean {
  const value = normalize(text);
  return /\b(?:repeat|recap|summari[sz]e|show|read(?: back)?)\b.*\b(?:order|cart|selections)\b|\bwhat (?:have i|did i|i have) (?:ordered|order)|\b(?:mera|meri) (?:order|cart).*\b(?:batao|bataye|dikhao|dohrao)|(?:میرا|میرے)\s*آرڈر.*(?:بتا|دکھا|دہرا)/u.test(
    value,
  );
}

// While closed, the review shows the order but is not confirmable: the cart stays 'building', so
// no Confirm button is attached and a later "confirm" gets a fresh review.
function review(
  company: Company,
  products: Product[],
  cart: Cart,
  lang: Language,
  now: string,
): string {
  const missing = missingDetails(company, cart, lang);
  if (missing) return `${cartSummary(company, products, cart, lang)}\n\n${missing}`;
  const open = isOpen(company, now);
  const quote = quoteCart(company, products, cart);
  const lines = quote.items
    .map(
      (item) =>
        `${item.quantity} × ${item.name}${item.variant ? ` (${item.variant})` : ''}${item.modifiers.length ? ` + ${item.modifiers.join(', ')}` : ''} — ${money(item.total)}${item.notes ? `\n  ${item.notes}` : ''}`,
    )
    .join('\n');
  const text = [
    say(lang, 'Please review your order:', 'اپنے آرڈر کا جائزہ لیں:', 'Apna order check kar lein:'),
    lines,
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

function menu(
  company: Company,
  products: Product[],
  lang: Language,
  query?: string,
  guided = false,
  link?: string,
) {
  const all = products.filter((p) => p.companyId === company.id);
  if (!all.length)
    return say(
      lang,
      'Our menu is not available right now. Type “staff” to talk to a person.',
      'ابھی مینو دستیاب نہیں ہے۔ کسی انسان سے بات کرنے کے لیے “عملہ” لکھیں۔',
      'Abhi menu available nahi hai. Kisi insaan se baat karne ke liye “staff” likhein.',
    );
  const words = dishWords(query);
  const textOf = (p: Product) => normalize(`${p.name} ${p.category} ${p.aliases.join(' ')}`);
  const matchingAll = (list: string[]) =>
    all.filter((p) => list.every((word) => textOf(p).includes(word)));
  // Prefer dishes matching every word; otherwise ignore words that match no dish at all
  // (an unlisted filler word must not hide a dish that is on the menu).
  const known = words.filter((word) => all.some((p) => textOf(p).includes(word)));
  const matching = !words.length
    ? all
    : matchingAll(words).length
      ? matchingAll(words)
      : known.length
        ? matchingAll(known)
        : [];
  // Never answer a menu request with an empty list: show the menu instead.
  const own = matching.length ? matching : all;
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
  const lines: string[] = [];
  for (const p of own) {
    const line = `${p.emoji} ${p.name} — ${money(p.price)}${p.available ? '' : ' · Unavailable'}${
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
    if (lines.join('\n').length + line.length > 2800 || lines.length >= 12) break;
    lines.push(line);
  }
  const linkLine = link ? `\n\n${menuLinkLine(lang, link)}` : '';
  return `${notFound}${company.name}\n${lines.join('\n')}${lines.length < own.length ? `\n\nShowing ${lines.length} of ${own.length} items. Ask for a category or item name to narrow the menu.` : ''}${guided ? '' : `\n\n${say(lang, 'Tell me the item and quantity, for example “2 chicken biryani”.', 'چیز کا نام اور تعداد بتائیں، جیسے “2 چکن بریانی”۔', 'Item aur quantity batayein, jaise “2 chicken biryani”.')}`}${linkLine}`;
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
// then; confirmed, booked, accepted or delivered never are, nor a payment received or more
// ordered. A polite request ("کنفرم کر دیں", "تصدیق کر دیجیے", "confirm kar di jiye") or the
// future ("deliver kar diya jayega", "کر دیا جائے گا") is not a claim.
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
// After submission, "your order has been placed" is true; placing more of it never is.
const ORDER_PLACED =
  /\border\b[^.!?\n]{0,30}?\b(?:placed|submitted)\b|\b(?:placed|submitted)\s+(?:your|the)\s+order\b/u;
const ordersMore = (value: string) =>
  value
    .split(/[.!?\n]+/u)
    .some(
      (sentence) =>
        /\b(?:placed|submitted|added)\b/u.test(sentence) &&
        /\b(?:another|additional|extra|second|separate)\b/u.test(sentence),
    );
// A payment said to be received, verified or confirmed: never the AI's to say, before or after
// the order, since restaurant staff check every transfer themselves. Not a condition ("once we
// receive the payment").
const NOT_IF = '(?<!\\b(?:once|when|after|until|till|if|before|jab|agar)\\b[^.!?\\n]{0,40})';
const PAYMENT_EN = new RegExp(
  `${NOT_IF}(?:\\b(?:payments?|transfers?|amount|money|jazz ?cash|easy ?paisa)\\b[^.!?\\n]{0,30}?(?<!\\b(?:be|to) )\\b(?:received|verified|cleared|credited|confirmed)\\b|\\b(?:received|got|verified|confirmed)\\s+(?:(?:your|the|aap ki)\\s+)?(?:(?:jazz ?cash|easy ?paisa|bank)\\s+)?(?:payments?|transfers?|money|amount)\\b)`,
  'u',
);
const PAYMENT_ROMAN = new RegExp(
  `${NOT_IF}\\b(?:payment|adaigi|adaegi|paise|paisay|pese|transfer|amount|raqam|jazz ?cash|easy ?paisa)\\b[^.!?\\n]{0,30}?\\b(?:(?:receive|recieve|confirm|verify|clear|submit|place)\\w*\\s*(?:ho|hu|kar|kr)\\s*|(?:mil|aa|pohanch|pahunch)\\s+)(?:gaya|gayi|gya|gyi|gai|gaye|gae|ge|chuka|chuki|chuke|liya|li|lia|diya|di|dia)\\b${NOT_DONE}`,
  'u',
);
const PAYMENT_URDU = new RegExp(
  `(?:ادائیگی|پیمنٹ|رقم|ٹرانسفر|پیسے|جاز ?کیش|ایزی ?پیسہ)[^۔.!?؟\\n]{0,30}?(?:(?:موصول|وصول|تصدیق|کلیئر|کنفرم|پلیس|سبمٹ)[^۔.!?؟\\n]{0,10}?${URDU_DONE}|(?:مل|آ|پہنچ)\\s?(?:گیا|گئی|گئے|چکا|چکی|چکے)(?![\\p{L}\\p{M}]))`,
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
// restaurant's own methods, and never "your JazzCash payment is accepted".
function withoutAcceptedMethods(text: string, methods: readonly PaymentMethod[]): string {
  if (!methods.length) return text;
  const name = `(?:${methods.map((method) => METHOD_WORDS[method]).join('|')})`;
  return text.replace(
    new RegExp(
      `(?<!\\b(?:your|the|aap ki|aapki|aap ka|aapka) )\\b${name}(?:\\s*(?:,|/|&|and|or|aur|ya)\\s*${name})*(?: payments?| transfers?)?(?: (?:is|are))?(?: (?:also|both|all|bhi))? accepted\\b`,
      'giu',
    ),
    ' ',
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
    (ENGLISH_PLACED.test(text) && (!submitted || ordersMore(value) || !ORDER_PLACED.test(value))) ||
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
// "in the biryani", "in it": not "in stock", "in the menu", "in garlic sauce" (a dish's name).
const EN_IN =
  '\\bin (?:it|this|that|them|these|those|(?:the|your|ur|this|that|my|our) (?!(?:menu|stock|evening|morning|night|afternoon|weekend|winter|summer|restaurant|shop|branch|outlet)\\b)\\p{L}+)\\b';
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
    // "is there egg in it", "any milk in the kheer": a food also sold as a dish once a dish it
    // would be in follows, with or without "?" (not "is there any fish?", "any fish in stock?").
    `${NOT_REQUEST}\\b(?:(?:is|are) there (?:any |some )?|any )(?:${FOOD_ALLERGENS})(?: (?:used|added|put|mixed|cooked))? ${EN_IN}`,
    `${NOT_REQUEST}\\b(?:${ALLERGENS})(?: (?:used|added|put|mixed|cooked))? ${EN_IN}[^.!]*\\?`,
    // "any peanuts in the karahi?", "any nuts?"
    `\\bany (?:${INGREDIENT_ALLERGENS})\\b${NOT_MENU}(?=\\s*(?:[?.!؟]|$|in\\b|on\\b|inside\\b|added\\b|used\\b))`,
    `\\b(?:does|do|did|will)\\s+(?!you\\b|u\\b|we\\b|i\\b)(?:\\S+\\s+){0,3}(?:have|has|use|contain)\\s+(?:any\\s+|some\\s+)?(?:${ALLERGENS})\\b`,
    `\\b(?:have|has)\\s+(?:any\\s+)?(?:${ALLERGENS}) in (?:it|them|this|that)\\b`,
    `\\b(?:made|cooked|fried|prepared)\\s+(?:with|in|using)\\s+(?:any\\s+)?(?:\\S+\\s+)?(?:${ALLERGENS})\\b`,
    `\\b(?:${ALLERGENS})\\b[^.!?]{0,30}\\bsafe\\b|\\bsafe\\b[^.!?]{0,30}\\b(?:${ALLERGENS})\\b`,
    `\\b(?:${INGREDIENT_ALLERGENS}) in (?!(?:the |our |your |ur )?(?:menu|stock)\\b|today\\b)[^.!]*\\?`,
    // "isme nuts hain?", "kya ismein anda hai?", "biryani mein nuts?", "biryani me koi nuts to
    // nahi?". A food also sold as a dish needs "hai" or "?": "paratha mein anda" is an order.
    `(?<!\\b(?:menu|stock|give|send|get|bring|show|tell|for|to|let|suggest|recommend|order|make|serve|add|want|need) )\\b${ROMAN_IN} (?:koi |kuch |bhi )?(?:(?:${ALLERGENS})(?: (?:to |bhi )?(?:nahi |nahin |nai )?${ROMAN_HAS}\\b|(?: (?:to |bhi )?(?:nahi|nahin|nai))?\\s*[?؟])|(?:${INGREDIENT_ALLERGENS})(?: (?:to |bhi )?(?:nahi|nahin|nai))?\\s*$)`,
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
const RESTRICTION =
  /\b(?:can['’]?t|cannot|can not|don['’]?t|do not|shouldn['’]?t|should not|must not) (?:have|eat|take|tolerate)\b|\b(?:avoid\w*|without|intoleran\w*|sensitiv\w*|reaction|masla|masle|masail|problem|issue|parhez|perhez|bina)\b|\b(?:nahi|nahin|nai|nhi) (?:kha|khaa|khana|khani|khata|khati|khate|chahiye|chahye|chaiye|leta|leti|lete)\b|نہیں کھا|نہیں چاہی|مسئل|پرہیز|بغیر/u;
function namesAvoidedAllergen(text: string, products: Product[], companyId: string): boolean {
  const value = normalize(text);
  if (ALLERGY_WORDS.test(value)) return true;
  // Dishes on the menu are taken out first, longest names first.
  const words = (text: string) => normalize(text.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' '));
  const labels = products
    .filter((product) => product.companyId === companyId)
    .flatMap((product) => [product.name, ...product.aliases])
    .map(words)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let rest = ` ${words(value)} `;
  for (const label of labels) rest = rest.split(` ${label} `).join('  ');
  return INGREDIENT_MENTION.test(rest) || (FOOD_MENTION.test(rest) && RESTRICTION.test(value));
}
// AI wording that vouches for a dish to someone who named an allergen, beyond the general
// assurances below: "Bilkul, aap kha sakte hain", "Yes, totally fine for you", "It only has
// chicken, rice and spices", "Nahi ji, isme nahi hota". A question back ("Is that okay for
// you?") vouches for nothing, and "stock mein nahi hai" is about the menu.
const ALLERGEN_CONTEXT_ASSURANCE = new RegExp(
  [
    `\\b(?:kha|khaa) ?(?:sakte|sakti|sakta|saktay|skte|skti|lein|len)\\b`,
    `\\b(?:fine|okay|ok|suitable|alright) (?:for|to) (?:you|your|eat|kids|children|everyone|anyone)\\b(?![^.!?\\n]*\\?)`,
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
    `\\bmade without (?:any )?(?:${ALLERGENS})\\b`,
    `\\b(?:eggs?|dairy|milk|nuts?|gluten)[- ]?less\\b`,
    `\\b(?:does ?n[o'’]?t|did ?n[o'’]?t|won['’]t|will not|never) (?:contain|have|include|use) (?:any )?(?:${ALLERGENS})\\b`,
    `\\bdo ?n[o'’]?t (?:contain|include|use) (?:any )?(?:${ALLERGENS})\\b`,
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
function requestedOptions(products: Product[], text: string): string[] {
  return [
    ...new Set(
      products
        .flatMap((product) => [...product.variants, ...product.modifiers])
        .filter((option) => contains(text, option.name))
        .map((option) => option.name),
    ),
  ];
}

/** Deliberately bounded simulator. Production adapters may extract the same actions. */
export function parseActions(
  company: Company,
  products: Product[],
  conversation: Conversation,
  text: string,
): BotAction[] {
  const value = normalize(text);
  if (isCartSummaryRequest(text)) return [{ type: 'cart_summary' }];
  // Interruptions and browsing are not answers to an outstanding item choice.
  if (/^(new order|start over|restart|naya order|نیا آرڈر)[.!،۔\s]*$/u.test(value))
    return [{ type: 'new_order' }];
  if (asksToCancelOrder(text)) return [{ type: 'cancel' }];
  if (asksForPerson(text)) return [{ type: 'handoff' }];
  if (/\b(?:do not|don't|dont|not|no)\s+(?:want|add|need)|نہیں چاہیے|nahi chahiye/u.test(value))
    return [{ type: 'answer', text: '' }];
  if (
    /^(menu|show menu|show me (?:the )?menu|مینو|menu dikhao|menu bhej(?: do)?)[.!،۔\s]*$/u.test(
      value,
    )
  )
    return [{ type: 'menu' }];
  const earlyResolution = resolveItemMention(products, company.id, text);
  const browsing =
    /^(?:what|which|how much|is |are |do you have|tell me|kitna|kya)|(?:\bprice\b|\bavailable\b|کتنے|قیمت|دستیاب)/u.test(
      value,
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
  if (conversation.pendingItemChoice && !browsing) {
    const selected = resolvePendingItemChoice(
      products,
      company.id,
      conversation.pendingItemChoice,
      text,
    );
    if (selected) {
      const requested = [
        ...conversation.pendingItemChoice.requestedOptionNames,
        ...requestedOptions([selected], text),
      ];
      // Only a count written next to the chosen dish, in its own part of the message, changes
      // the one asked about: "3 naan", "naan 3, chicken wali" or "house 12" is not its count,
      // nor the 4 in "chicken wali 4 naan", which may be the naan's.
      const explicitQuantity = !/^option\b/u.test(value)
        ? clearQuantityNear(selected, text, products)
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
          modifierIds: selected.modifiers
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
  const explicitProducts = products.filter(
    (p) =>
      p.companyId === company.id && [p.name, ...p.aliases].some((label) => contains(value, label)),
  );
  const distinctMentions =
    explicitProducts.length > 1 &&
    explicitProducts.every((p) =>
      [p.name, ...p.aliases].some(
        (label) =>
          contains(value, label) &&
          !explicitProducts.some(
            (other) =>
              other.id !== p.id &&
              [other.name, ...other.aliases].some(
                (otherLabel) => normalize(otherLabel) === normalize(label),
              ),
          ),
      ),
    );
  if (earlyResolution.kind === 'ambiguous' && !distinctMentions)
    return [
      {
        type: 'clarify_item',
        candidateProductIds: earlyResolution.products.slice(0, 12).map((product) => product.id),
        quantity: earlyResolution.quantity,
        requestedOptionNames: requestedOptions(earlyResolution.products, text),
        originalText: text,
      },
    ];
  const actions: BotAction[] = [];
  const matches = products
    .filter((p) => p.companyId === company.id)
    .map((product) => ({
      product,
      alias: [product.name, ...product.aliases]
        .filter((alias) => contains(value, alias))
        .sort((a, b) => b.length - a.length)[0],
    }))
    .filter((m): m is { product: Product; alias: string } => !!m.alias)
    .sort((a, b) => value.indexOf(normalize(a.alias)) - value.indexOf(normalize(b.alias)));
  if (!matches.length) {
    const detailLike =
      /(?:my name is|name\s*:|mera naam|mera nam|میرا نام|نام\s*:|address\s*:|pata\s*:|پتہ\s*:|پتا\s*:|\bpickup\b|\bdelivery\b|پک اپ|ڈیلیوری|ڈلیوری)/iu.test(
        text,
      );
    const resolution = detailLike
      ? ({ kind: 'none', quantity: 1 } as const)
      : resolveItemMention(products, company.id, text);
    if (resolution.kind === 'ambiguous')
      return [
        {
          type: 'clarify_item',
          candidateProductIds: resolution.products.slice(0, 12).map((product) => product.id),
          quantity: resolution.quantity,
          requestedOptionNames: requestedOptions(resolution.products, text),
          originalText: text,
        },
      ];
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
      ];
    }
  }
  const sameMention = matches.filter(
    (match) =>
      value.indexOf(normalize(match.alias)) === value.indexOf(normalize(matches[0]?.alias ?? '')) &&
      normalize(match.alias) === normalize(matches[0]?.alias ?? ''),
  );
  if (sameMention.length > 1)
    return [
      {
        type: 'clarify_item',
        candidateProductIds: sameMention.slice(0, 12).map((match) => match.product.id),
        quantity: Math.max(
          1,
          Math.min(
            50,
            quantityOfMention(sameMention[0]!.product, sameMention[0]!.alias, text, products) ?? 1,
          ),
        ),
        requestedOptionNames: requestedOptions(
          sameMention.map((match) => match.product),
          text,
        ),
        originalText: text,
      },
    ];
  if (
    matches.length &&
    /^(?:what|how much|is |are |do you have|tell me|kitna|kya)|(?:\bprice\b|\bavailable\b|کتنے|قیمت|دستیاب)/u.test(
      value,
    )
  )
    return [{ type: 'menu', query: matches[0]!.product.name }];
  if (
    matches.length &&
    /\b(?:do not|don't|dont|not|no)\s+(?:want|add|need)|نہیں چاہیے|nahi chahiye/u.test(value)
  )
    return [{ type: 'answer', text: '' }];
  for (const { product, alias } of matches) {
    const at = value.indexOf(normalize(alias));
    const prefix = value.slice(Math.max(0, at - 24), at);
    if (/\b(remove|delete|hatao)\b|نکال|ہٹا/u.test(prefix)) {
      actions.push({ type: 'remove_item', productId: product.id });
      continue;
    }
    const variant = product.variants.find((v) => contains(value, v.name));
    const modifiers = product.modifiers.filter(
      (m) =>
        contains(value, m.name) &&
        !/\b(without|no|remove)\s*$/u.test(
          value.slice(
            Math.max(0, value.indexOf(normalize(m.name)) - 15),
            value.indexOf(normalize(m.name)),
          ),
        ),
    );
    actions.push({
      type: 'add_item',
      productId: product.id,
      // The count next to this mention, in its own part of the message: "naan 3, chicken
      // biryani" and "naan 3 chicken biryani" give the biryani 1 and the naan 3.
      quantity: quantityOfMention(product, alias, text, products) ?? 1,
      variantId: variant?.id,
      modifierIds: modifiers.map((m) => m.id),
    });
  }
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
      `Order ${ref} is being prepared.`,
      `آرڈر ${ref} تیار ہو رہا ہے۔`,
      `Order ${ref} tayyar ho raha hai.`,
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
  // The menu page's own address is not an outcome claim, whatever words its slug holds, and
  // nor is saying the restaurant takes a payment method it does take.
  const claims = (text: string) =>
    unsafeModelText(
      input.menuLink ? text.replaceAll(input.menuLink, '') : text,
      conversation.cart.status === 'submitted',
      paymentMethods(company),
    );
  // An allergy reassurance only in the owner's own approved words, quoted exactly.
  const ownerWording = [
    ...company.faqs.map((faq) => faq.answer),
    ...configuration.behaviorRules.map((rule) => rule.response),
  ].map((text) => normalize(text));
  const assures = (text: string) =>
    assuresSafety(text) &&
    !ownerWording.some((owner) => !!text.trim() && owner === normalize(text));
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
  const shownAt =
    input.receivedAt && Number.isFinite(Date.parse(input.receivedAt))
      ? input.receivedAt
      : input.now;
  const reviewAge = cart.reviewedAt ? Date.parse(shownAt) - Date.parse(cart.reviewedAt) : NaN;
  const reviewFresh = reviewAge >= 0 && reviewAge <= REVIEW_FRESH_MS;
  // The review text this turn shows, so finish() records which reply carried it.
  let shownReview: string | undefined;
  const showReview = () => {
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
  const allergyQuestion =
    !input.action &&
    (asksAboutAllergens(input.text) ||
      (aiWording.some((text) => ALLERGEN_CONTEXT_ASSURANCE.test(normalize(text))) &&
        namesAvoidedAllergen(input.text, products, company.id)) ||
      (!!lastAsked &&
        asksAboutAllergens(lastAsked.text) &&
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
      const modelFirst = traces.includes('menu') || traces.includes('clarify_item');
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
      (!ORDERLY_MARKER.test(input.text.trim()) && asksForPerson(input.text))
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
  if (
    !input.action &&
    actions &&
    requested.some((action) => action.type === 'add_item' || action.type === 'clarify_item')
  ) {
    const deterministic = parseActions(company, products, next, input.text);
    const first = deterministic[0];
    if (first?.type === 'clarify_item' && requested.some((action) => action.type === 'add_item')) {
      // The dish to choose is asked about. The AI's additions of other dishes stand ("karahi 4
      // naan" with two karahis: the naan), added first so the choice stays open. A count that
      // may be the next dish's (the 4) is not the choice's: the AI's count for it, else 1.
      const choice = new Set(first.candidateProductIds);
      const others = requested.filter(
        (action) => action.type === 'add_item' && !choice.has(action.productId),
      );
      const between = products.some(
        (product) =>
          choice.has(product.id) &&
          quantityNear(product, input.text, products) !== undefined &&
          clearQuantityNear(product, input.text, products) === undefined,
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
      (requested.some((action) => action.type === 'clarify_item') || next.pendingItemChoice)
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
      const explicit = !!product && clearQuantityNear(product, input.text, products) !== undefined;
      const quantityFor = (proposed: number) =>
        !pending || explicit
          ? first.quantity
          : proposed === pending.quantity || mentionsQuantity(input.text, proposed)
            ? proposed
            : first.quantity;
      requested = requested.map((action) => {
        if (action.type === 'clarify_item')
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
      if (actions.some((action) => action.type === 'clarify_item')) correctedInterpretation = true;
      traces.push('item_choice_resolved');
    } else if (
      first?.type === 'menu' &&
      requested.some((action) => action.type === 'add_item' || action.type === 'clarify_item')
    ) {
      requested = deterministic;
      correctedInterpretation = true;
      traces.push('browse_cart_mutation_prevented');
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
        reply = `${say(lang, 'Which one would you like?', 'آپ کون سا لینا چاہیں گے؟', 'Aap kaun sa lena chahenge?')}\n${candidates
          .map(
            (product, index) =>
              `${index + 1}. ${product.name}${product.available ? '' : say(lang, ' · Unavailable', ' · دستیاب نہیں', ' · available nahi')}`,
          )
          .join('\n')}`;
        continue;
      }
      if (action.type === 'menu') {
        reply = menu(company, products, lang, action.query, !!modelResponse, input.menuLink);
        continue;
      }
      if (action.type === 'cart_summary') {
        reply = cartSummary(company, products, cart, lang);
        continue;
      }
      if (action.type === 'new_order') {
        // Keep the monotonically increasing revision to prevent submission-key reuse.
        const revision = cart.revision + 1;
        Object.keys(cart).forEach(
          (key) => delete (cart as unknown as Record<string, unknown>)[key],
        );
        Object.assign(cart, emptyCart(), { revision });
        delete next.pendingItemChoice;
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
        if (!Number.isInteger(action.quantity) || action.quantity < 1 || action.quantity > 50)
          throw new Error('Choose a quantity between 1 and 50.');
        const trial: Cart = structuredClone(cart);
        const line = {
          productId: action.productId,
          quantity: action.quantity,
          variantId: action.variantId,
          modifierIds: [...(action.modifierIds ?? [])].sort(),
          notes: (action.notes ?? '').slice(0, 300),
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
        delete next.pendingItemChoice;
        invalidate(cart);
        settleFulfillment();
        const product = products.find(
          (p) => p.id === action.productId && p.companyId === company.id,
        )!;
        if (modelResponse) {
          const quoted = quote.items[same ? trial.items.indexOf(same) : trial.items.length - 1]!;
          cartFacts.push(
            say(
              lang,
              `Added ${action.quantity} × ${product.name}${quoted.variant ? ` (${quoted.variant})` : ''}${quoted.modifiers.length ? ` + ${quoted.modifiers.join(', ')}` : ''} — ${money(quoted.unitPrice)} each.${line.notes ? ` Notes: ${line.notes}` : ''}`,
              `${action.quantity} × ${product.name} شامل کر دیا — فی عدد ${money(quoted.unitPrice)}۔`,
              `${action.quantity} × ${product.name} add kar diya — ${money(quoted.unitPrice)} each.`,
            ),
          );
        } else
          reply = say(
            lang,
            `Added ${action.quantity} × ${product.name}. Add anything else, or send “review”.`,
            `${action.quantity} × ${product.name} شامل کر دیا۔ مزید چیز بتائیں یا “جائزہ” لکھیں۔`,
            `${action.quantity} × ${product.name} add kar diya. Aur kuch chahiye, ya “review” likhein.`,
          );
        continue;
      }
      if (action.type === 'remove_item') {
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

const transitions: Record<OrderStatus, OrderStatus[]> = {
  pending: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
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
