import { botConfig } from '../shared/bot';
import type {
  BotAction,
  Cart,
  Company,
  Conversation,
  Language,
  Order,
  OrderLine,
  OrderStatus,
  Product,
  TurnInput,
  TurnResult,
} from '../shared/types';
import { money } from '../shared/types';

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

function normalize(text: string): string {
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
const safeMoney = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error('Invalid catalog price. Please ask staff for help.');
  return n;
};
function invalidate(cart: Cart) {
  cart.revision += 1;
  cart.status = 'building';
  delete cart.reviewedRevision;
  delete cart.quoteHash;
  delete cart.quotedTotal;
}

export function isOpen(company: Company, now: string): boolean {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return false;
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
    const toMinute = (time: string) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
      const [h, m] = time.split(':').map(Number);
      return h! * 60 + m!;
    };
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
      (z) => normalize(z.name) === normalize(cart.zone ?? ''),
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

function missingDetails(company: Company, cart: Cart, lang: Language): string | undefined {
  const config = botConfig(company);
  for (const step of config.steps) {
  if (step === 'items' && !cart.items.length)
    return say(
      lang,
      'Your cart is empty. Choose something from the menu first.',
      'آپ کی ٹوکری خالی ہے۔ پہلے مینو سے کوئی چیز چنیں۔',
      'Aap ka cart khaali hai. Pehle menu se koi cheez chunain.',
    );
  if (step === 'fulfillment' && !cart.fulfillment)
    return say(
      lang,
      'Would you like pickup or delivery?',
      'آپ پک اپ کریں گے یا ڈیلیوری چاہیے؟',
      'Aap pickup karenge ya delivery chahiye?',
    );
  if (step === 'name' && !cart.customerName?.trim())
    return say(
      lang,
      'What name should I put on the order? Reply “My name is Ali”.',
      'آرڈر کے لیے آپ کا نام کیا ہے؟ لکھیں: میرا نام علی ہے',
      'Order ke liye aap ka naam? Likhein: Mera naam Ali hai.',
    );
  if (step === 'address' && cart.fulfillment === 'delivery' && !cart.zone)
    return say(
      lang,
      `Which delivery area? ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
      `ڈیلیوری کا علاقہ بتائیں: ${company.deliveryZones.map((z) => z.name).join('، ')}۔`,
      `Delivery ka ilaqa batayein: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
    );
  if (step === 'address' && cart.fulfillment === 'delivery' && !cart.address?.trim())
    return say(
      lang,
      'Please send your complete address: “Address: house, street, area”.',
      'مکمل پتہ لکھیں: پتہ: گھر، گلی، علاقہ',
      'Mukammal pata likhein: Address: ghar, gali, ilaqa.',
    );
  }
}

function review(company: Company, products: Product[], cart: Cart, lang: Language): string {
  const missing = missingDetails(company, cart, lang);
  if (missing) return missing;
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
    say(
      lang,
      '\nReply “confirm” to submit this order for restaurant acceptance.',
      '\nریسٹورنٹ کی منظوری کے لیے آرڈر بھیجنے کو “تصدیق” لکھیں۔',
      '\nRestaurant ki manzoori ke liye “confirm” ya “haan” likhein.',
    ),
  ].join('\n');
  if (text.length > 3500)
    throw new Error('This order is too large for one message. Please ask staff to complete it.');
  cart.status = 'awaiting_confirmation';
  cart.reviewedRevision = cart.revision;
  cart.quoteHash = quote.hash;
  cart.quotedTotal = quote.total;
  return text;
}

function menu(company: Company, products: Product[], lang: Language, query?: string) {
  const own = products.filter(
    (p) =>
      p.companyId === company.id &&
      (!query ||
        normalize(`${p.name} ${p.category} ${p.aliases.join(' ')}`).includes(normalize(query))),
  );
  if (!own.length)
    return say(
      lang,
      'No matching menu items. Try “menu” to see everything.',
      'یہ چیز مینو میں نہیں ملی۔ پورا مینو دیکھنے کے لیے “مینو” لکھیں۔',
      'Yeh item menu mein nahi mila. Pura menu dekhne ke liye “menu” likhein.',
    );
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
  return `${company.name}\n${lines.join('\n')}${lines.length < own.length ? `\n\nShowing ${lines.length} of ${own.length} items. Ask for a category or item name to narrow the menu.` : ''}\n\n${say(lang, 'Tell me the item and quantity, for example “2 chicken biryani”.', 'چیز کا نام اور تعداد بتائیں، جیسے “2 چکن بریانی”۔', 'Item aur quantity batayein, jaise “2 chicken biryani”.')}`;
}

const affirmative = (text: string) =>
  /^(confirm(?: order| it)?|yes(?: please)?|yes confirm|place (?:my |the )?order|submit(?: order)?|haan(?: ji)?|han(?: ji)?|ji(?: haan| han)?|tasdeeq|order confirm(?: kar do| kardo)?|تصدیق|ہاں(?: جی)?|جی(?: ہاں)?|آرڈر کنفرم|کنفرم|تصدیق کریں)[.!،۔\s]*$/u.test(
    normalize(text),
  );
function contains(text: string, phrase: string): boolean {
  const p = normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${p}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

/** Deliberately bounded simulator. Production adapters may extract the same actions. */
export function parseActions(
  company: Company,
  products: Product[],
  conversation: Conversation,
  text: string,
): BotAction[] {
  const value = normalize(text);
  if (affirmative(value)) return [{ type: 'confirm' }];
  if (/^(new order|start over|restart|naya order|نیا آرڈر)[.!،۔\s]*$/u.test(value))
    return [{ type: 'new_order' }];
  if (/^(cancel(?: order)?|cancel karo|cancel kardo|منسوخ|آرڈر منسوخ)[.!،۔\s]*$/u.test(value))
    return [{ type: 'cancel' }];
  if (/\b(human|staff|manager|person|insaan)\b|عملہ|انسان|مینیجر/u.test(value))
    return [{ type: 'handoff' }];
  if (
    /^(menu|show menu|show me (?:the )?menu|مینو|menu dikhao|menu bhej(?: do)?|salam|salaam|hello|hi|السلام علیکم)[.!،۔\s]*$/u.test(
      value,
    )
  )
    return [{ type: 'menu' }];
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
    const number = prefix.match(/(\d+)\s*(?:x|×)?\s*$/u)?.[1];
    const word = prefix.match(
      /\b(one|two|three|four|five|a|an|ek|aik|do|teen|char|panch)\s*$/u,
    )?.[1];
    const urduWord = prefix.match(/(ایک|دو|تین|چار|پانچ)\s*$/u)?.[1];
    const quantityWords: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      a: 1,
      an: 1,
      ek: 1,
      aik: 1,
      do: 2,
      teen: 3,
      char: 4,
      panch: 5,
      ایک: 1,
      دو: 2,
      تین: 3,
      چار: 4,
      پانچ: 5,
    };
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
      quantity: number ? Number(number) : (quantityWords[word ?? urduWord ?? ''] ?? 1),
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

export function processTurn(
  company: Company,
  products: Product[],
  conversation: Conversation,
  input: TurnInput,
  actions?: BotAction[],
): TurnResult {
  if (conversation.companyId !== company.id) throw new Error('Company access denied.');
  if (!Number.isFinite(new Date(input.now).getTime()))
    throw new Error('Invalid message timestamp.');
  const next: Conversation = structuredClone(conversation);
  const configuration = botConfig(company);
  const traces: string[] = [];
  if (next.messages.some((m) => m.id === input.messageId))
    return {
      conversation: next,
      reply: next.messages.find((m) => m.id === `${input.messageId}:reply`)?.text ?? '',
      traces: ['duplicate_message_ignored'],
    };
  next.language = languageOf(input.text, next.language);
  if (configuration.language !== 'auto') next.language = configuration.language;
  next.botVersion = company.bot?.published?.version;
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
  let reply = '',
    order: Order | undefined;
  const finish = (): TurnResult => {
    if (company.bot?.published && reply) {
      if (/^(hi|hello|salam|سلام|ہیلو)$/iu.test(input.text.trim()) && configuration.greeting) reply = `${configuration.greeting}\n\n${missingDetails(company, cart, lang) ?? reply}`;
      else if (configuration.personality === 'warm' && lang === 'en' && traces.includes('add_item')) reply = `Happy to help. ${reply}`;
    }
    if (reply)
      next.messages.push({
        id: `${input.messageId}:reply`,
        role: 'assistant',
        text: reply,
        createdAt: input.now,
      });
    if (cart.customerName) next.customerName = cart.customerName;
    return { conversation: next, order, reply, traces };
  };
  if (next.mode === 'human' || !company.botEnabled) {
    next.mode = 'human';
    traces.push('human_mode_message_saved');
    return finish();
  }
  const requested = input.action
    ? [input.action]
    : (actions ?? parseActions(company, products, next, input.text));
  if (requested.length > 8) {
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
        reply = say(
          lang,
          'This conversation is now assigned to staff. The bot is paused until they resume it.',
          'یہ گفتگو اب عملے کے پاس ہے۔ بوٹ روک دیا گیا ہے۔',
          'Yeh conversation ab staff ke paas hai. Bot pause kar diya gaya hai.',
        );
        if (configuration.handoffMessage) reply = configuration.handoffMessage;
        break;
      }
      if (action.type === 'menu') {
        reply = menu(company, products, lang, action.query);
        continue;
      }
      if (action.type === 'new_order') {
        // Keep the monotonically increasing revision to prevent submission-key reuse.
        const revision = cart.revision + 1;
        Object.keys(cart).forEach(
          (key) => delete (cart as unknown as Record<string, unknown>)[key],
        );
        Object.assign(cart, emptyCart(), { revision });
        reply = say(
          lang,
          'Started a new cart. What would you like?',
          'نئی ٹوکری تیار ہے۔ آپ کیا پسند کریں گے؟',
          'Naya cart tayyar hai. Aap kya lena chahenge?',
        );
        continue;
      }
      if (action.type === 'cancel') {
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
        const faq = company.faqs.find(
          (f) =>
            normalize(input.text).includes(normalize(f.question)) ||
            (action.text === f.answer && f.answer.trim()),
        );
        reply =
          faq?.answer ??
          say(
            lang,
            'I can help with the menu, pickup or delivery orders, and restaurant information. Tell me an item and quantity, or send “menu”. For anything else, send “staff”.',
            'میں مینو، پک اپ اور ڈیلیوری آرڈرز میں مدد کر سکتا ہوں۔ چیز اور تعداد بتائیں یا “مینو” لکھیں۔ دوسری مدد کے لیے “عملہ” لکھیں۔',
            'Main menu, pickup aur delivery orders mein madad kar sakta hoon. Item aur quantity batayein ya “menu” likhein. Aur madad ke liye “staff” likhein.',
          );
        traces.push(faq ? 'approved_faq' : 'unverified_model_answer_ignored');
        continue;
      }
      if (cart.status === 'submitted') {
        reply = say(
          lang,
          'This cart has already been submitted. Check the order status with staff, or send “new order” to start another.',
          'یہ آرڈر پہلے بھیجا جا چکا ہے۔ حالت کے لیے عملے سے پوچھیں، یا “نیا آرڈر” لکھیں۔',
          'Yeh cart pehle submit ho chuka hai. Status staff se poochein, ya “new order” likhein.',
        );
        traces.push('duplicate_submission_prevented');
        continue;
      }
      if (cart.status === 'cancelled') {
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
        quoteCart(company, products, { ...trial, fulfillment: 'pickup' });
        cart.items = trial.items;
        invalidate(cart);
        const product = products.find(
          (p) => p.id === action.productId && p.companyId === company.id,
        )!;
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
        if (action.fulfillment && configuration.fulfillment !== 'both' && action.fulfillment !== configuration.fulfillment)
          throw new Error(`This restaurant currently offers ${configuration.fulfillment} only.`);
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
          if (!zone)
            throw new Error(
              `We deliver to: ${company.deliveryZones.map((z) => z.name).join(', ')}.`,
            );
          details.zone = zone.name;
        }
        if (action.fulfillment) {
          details.fulfillment = action.fulfillment;
          if (action.fulfillment === 'pickup') {
            delete details.address;
            delete details.zone;
          }
        }
        cart.customerName = details.customerName;
        cart.fulfillment = details.fulfillment;
        cart.address = details.address;
        cart.zone = details.zone;
        if (
          before !==
          JSON.stringify([details.fulfillment, details.customerName, details.address, details.zone])
        )
          invalidate(cart);
        reply = missingDetails(company, cart, lang) ?? review(company, products, cart, lang);
        continue;
      }
      if (action.type === 'review') {
        reply = review(company, products, cart, lang);
        continue;
      }
      if (action.type === 'confirm') {
        if (!input.action && !affirmative(input.text)) {
          reply = say(
            lang,
            'Please review your order and explicitly reply “confirm” to submit it.',
            'آرڈر دیکھ کر بھیجنے کے لیے واضح طور پر “تصدیق” لکھیں۔',
            'Order review kar ke wazeh taur par “confirm” likhein.',
          );
          traces.push('unconfirmed_model_action_rejected');
          continue;
        }
        if (!isOpen(company, input.now)) {
          reply = say(
            lang,
            `We are currently closed. Ordering hours are ${company.openingHours.start}–${company.openingHours.end} (${company.timezone}). Your cart is saved.`,
            `ہم اس وقت بند ہیں۔ آرڈر کا وقت ${company.openingHours.start}–${company.openingHours.end} ہے۔ آپ کی ٹوکری محفوظ ہے۔`,
            `Hum is waqt band hain. Order ka waqt ${company.openingHours.start}–${company.openingHours.end} hai. Cart save hai.`,
          );
          continue;
        }
        const missing = missingDetails(company, cart, lang);
        if (missing) {
          reply = missing;
          continue;
        }
        const quote = quoteCart(company, products, cart);
        if (
          initialReview.status !== 'awaiting_confirmation' ||
          initialReview.revision !== cart.revision ||
          initialReview.hash !== quote.hash ||
          cart.reviewedRevision !== cart.revision ||
          cart.quoteHash !== quote.hash ||
          (action.revision !== undefined && action.revision !== cart.revision)
        ) {
          traces.push('fresh_confirmation_required');
          reply = `${say(lang, 'Please confirm the current details below.', 'نیچے دی گئی موجودہ تفصیل کی تصدیق کریں۔', 'Neeche di gayi maujooda details confirm karein.')}\n\n${review(company, products, cart, lang)}`;
          continue;
        }
        const submissionKey = `${company.id}:${next.id}:${cart.revision}`;
        const id = idFor(submissionKey);
        order = {
          id,
          companyId: company.id,
          conversationId: next.id,
          reference: `ORD-${id.replaceAll('-', '').slice(-8).toUpperCase()}`,
          submissionKey,
          customerName: cart.customerName!,
          customerPhone: next.customerPhone,
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
          createdAt: input.now,
          updatedAt: input.now,
          sandbox: conversation.channel === 'demo',
          phoneConfirmationRequired: !!company.bot?.published && configuration.requirePhoneConfirmation,
        };
        cart.status = 'submitted';
        cart.orderId = id;
        reply = say(
          lang,
          `Order ${order.reference} received — ${money(order.total)}. Awaiting restaurant acceptance. Payment is cash ${order.fulfillment === 'pickup' ? 'at pickup' : 'on delivery'}.`,
          `آرڈر ${order.reference} موصول ہوا — ${money(order.total)}۔ ریسٹورنٹ کی منظوری کا انتظار ہے۔ ادائیگی نقد ہوگی۔`,
          `Order ${order.reference} receive ho gaya — ${money(order.total)}. Restaurant ki manzoori ka intezar hai. Payment cash hogi.`,
        );
        if (order.phoneConfirmationRequired) reply += say(lang, '\nRestaurant staff will call to confirm before accepting your order.', '\nعملہ آرڈر منظور کرنے سے پہلے فون پر تصدیق کرے گا۔', '\nRestaurant staff order accept karne se pehle call kar ke confirm karega.');
        traces.push('order_pending_restaurant_acceptance');
        break;
      }
    } catch (error) {
      reply = error instanceof Error ? error.message : 'Please ask staff for help.';
      traces.push(`validation_failed:${action.type}`);
      break;
    }
  }
  if (!reply)
    reply = say(
      lang,
      'Send “menu” to get started.',
      'شروع کرنے کے لیے “مینو” لکھیں۔',
      'Shuru karne ke liye “menu” likhein.',
    );
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
