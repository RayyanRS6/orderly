import { describe, expect, it } from 'vitest';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { defaultBot, offeredFulfillment } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  BotConfig,
  Company,
  Conversation,
  ModelResponse,
  Product,
  TurnInput,
} from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const later = (minutes: number) => new Date(Date.parse(now) + minutes * 60000).toISOString();
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const fresh = () => createConversation(company.id, '923000000077', 'demo', now);
let message = 0;
function turn(
  c: Conversation,
  text: string,
  options: {
    actions?: BotAction[];
    response?: ModelResponse;
    action?: BotAction;
    catalog?: Product[];
    restaurant?: Company;
    at?: string;
    extra?: Partial<TurnInput>;
  } = {},
) {
  return processTurn(
    options.restaurant ?? company,
    options.catalog ?? products,
    c,
    {
      messageId: `pre-a-${++message}`,
      text,
      action: options.action,
      now: options.at ?? now,
      ...options.extra,
    },
    options.actions,
    options.response,
  );
}
const model = (text = '', askFor: ModelResponse['askFor'] = 'none'): ModelResponse => ({
  text,
  askFor,
});
function reviewed(restaurant = company, at = now) {
  let c = turn(fresh(), '2 chicken biryani', { restaurant, at }).conversation;
  c = turn(c, '', {
    action: { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
    restaurant,
    at,
  }).conversation;
  return c;
}
const published = (config: Partial<BotConfig>): Company['bot'] => {
  const bot = { ...defaultBot, ...config };
  return {
    draft: bot,
    revision: 1,
    history: [],
    published: { version: 1, config: bot, publishedAt: now, publishedBy: 'test' },
  };
};

describe('F33: a typed confirmation counts only against the latest review', () => {
  it('records which reply showed the review, and when', () => {
    const c = reviewed();
    const last = c.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.text).toContain('Reply “confirm”');
    expect(c.cart).toMatchObject({ reviewMessageId: last.id, reviewedAt: now });
    expect(turn(c, 'confirm').order?.total).toBe(90000);
  });

  it('does not place the order on a “yes” to a later question', () => {
    const answered = turn(reviewed(), 'is raita included?', {
      actions: [{ type: 'answer', text: '' }],
      response: model('Raita is extra. Would you like to add raita?'),
    });
    expect(answered.conversation.cart.status).toBe('awaiting_confirmation');
    const yes = turn(answered.conversation, 'yes', {
      actions: [{ type: 'confirm' }],
      response: model('Great, sending it now!'),
    });
    expect(yes.order).toBeUndefined();
    expect(yes.traces).toContain('unconfirmed_model_action_rejected');
    expect(yes.reply).toContain('Please review your order:');
    expect(yes.reply).not.toContain('sending it now');
    // The review was shown again, so a plain "confirm" now places it.
    expect(
      turn(yes.conversation, 'confirm', { actions: [{ type: 'confirm' }] }).order,
    ).toBeDefined();
  });

  it('shows the review again for an explicit confirm after another message', () => {
    const answered = turn(reviewed(), 'is raita included?', {
      actions: [{ type: 'answer', text: '' }],
      response: model('Raita is extra.'),
    });
    const confirm = turn(answered.conversation, 'confirm');
    expect(confirm.order).toBeUndefined();
    expect(confirm.traces).toContain('fresh_confirmation_required');
    expect(confirm.reply).toContain('Please confirm the current details below.');
    expect(turn(confirm.conversation, 'confirm').order).toBeDefined();
  });

  it('shows the review again when it is more than an hour old', () => {
    const late = turn(reviewed(), 'confirm', { at: later(120) });
    expect(late.order).toBeUndefined();
    expect(late.traces).toContain('fresh_confirmation_required');
    expect(late.conversation.cart.reviewedAt).toBe(later(120));
    expect(turn(late.conversation, 'confirm', { at: later(121) }).order).toBeDefined();
    // Within the hour it is still the latest review.
    expect(turn(reviewed(), 'confirm', { at: later(59) }).order).toBeDefined();
  });

  it('does not submit the pre-handoff cart after staff hand the chat back', () => {
    let c = turn(reviewed(), 'staff').conversation;
    expect(c.mode).toBe('human');
    c = turn(c, 'can you add raita?').conversation;
    c.messages.push({ id: 'staff-1', role: 'staff', text: 'Sure, adding raita.', createdAt: now });
    c.mode = 'bot';
    const ji = turn(c, 'ji', { actions: [{ type: 'confirm' }] });
    expect(ji.order).toBeUndefined();
    // "ji" switches the chat to Roman Urdu; the review is shown again.
    expect(ji.reply).toContain('Apna order check kar lein:');
  });

  it('does not count a review that never reached the customer', () => {
    const c = reviewed();
    c.messages.at(-1)!.delivery = 'failed';
    const confirm = turn(c, 'confirm');
    expect(confirm.order).toBeUndefined();
    expect(confirm.traces).toContain('fresh_confirmation_required');
  });

  it('does not keep a review the final reply did not carry', () => {
    let c = turn(fresh(), '2 chicken biryani').conversation;
    c = turn(c, '', { action: { type: 'set_details', fulfillment: 'pickup' } }).conversation;
    const result = turn(c, 'my name is Ali, then staff', {
      actions: [
        { type: 'set_details', customerName: 'Ali' },
        { type: 'review' },
        { type: 'handoff' },
      ],
      response: model(),
    });
    expect(result.reply).not.toContain('Please review your order:');
    expect(result.conversation.cart.status).toBe('building');
    expect(result.conversation.cart.reviewMessageId).toBeUndefined();
  });

  it('hints confirm to the AI for a bare yes only straight after the review', () => {
    const c = reviewed();
    expect(parseActions(company, products, c, 'yes')).toEqual([{ type: 'confirm' }]);
    const answered = turn(c, 'is raita included?', {
      actions: [{ type: 'answer', text: '' }],
      response: model('Raita is extra. Would you like to add raita?'),
    }).conversation;
    expect(parseActions(company, products, answered, 'yes')).toEqual([
      { type: 'answer', text: '' },
    ]);
    expect(parseActions(company, products, answered, 'haan')).toEqual([
      { type: 'answer', text: '' },
    ]);
    expect(parseActions(company, products, answered, 'confirm')).toEqual([{ type: 'confirm' }]);
  });
});

describe('F34: common ways of confirming are understood, and nothing else', () => {
  it.each([
    'Yes, confirm',
    'yes confirm please',
    'confirm please',
    'ok',
    'okay',
    'yess',
    'jee',
    'han g',
    'confirm kar dein',
    'confirm kardo',
    'confirm kr do',
    'theek hai',
    'Confirm ✅',
    'confirmed',
    'yes 👍',
    '👍',
    'ٹھیک ہے',
    'جی',
    'ہاں',
    'جی کنفرم',
    'کنفرم کر دیں',
    'place order',
    'order place kar do',
    'yes place my order',
    'haan confirm',
    'Confirm.',
    'Yes!',
  ])('places the reviewed order for “%s”', (text) => {
    const result = turn(reviewed(), text, { actions: [{ type: 'confirm' }], response: model() });
    expect(result.order?.total, result.reply).toBe(90000);
  });

  it.each([
    'confirm?',
    'confirm nahi',
    'abhi confirm mat karo',
    '❌ confirm',
    'no',
    'not yet',
    'yes, add raita',
    '2 more naan, confirm',
    'ok 🤔',
    'نہیں',
  ])('never places it for “%s”', (text) => {
    const result = turn(reviewed(), text, { actions: [{ type: 'confirm' }], response: model() });
    expect(result.order).toBeUndefined();
    expect(result.traces).toContain('unconfirmed_model_action_rejected');
  });
});

describe('F37: only the pickup or delivery the restaurant can offer', () => {
  const noZones: Company = { ...company, deliveryZones: [] };
  const deliveryOnly = (zones = company.deliveryZones): Company => ({
    ...company,
    deliveryZones: zones,
    bot: published({ fulfillment: 'delivery' }),
  });

  it('works out the choices from the setting and the delivery areas', () => {
    expect(offeredFulfillment(company)).toBe('both');
    expect(offeredFulfillment(noZones)).toBe('pickup');
    expect(offeredFulfillment(deliveryOnly())).toBe('delivery');
    expect(offeredFulfillment(deliveryOnly([]))).toBeUndefined();
    expect(offeredFulfillment({ ...company, bot: published({ fulfillment: 'pickup' }) })).toBe(
      'pickup',
    );
  });

  it('treats “both” with no delivery areas as pickup only, without asking', () => {
    const added = turn(fresh(), '1 chicken biryani', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      response: model('Pickup or delivery?', 'fulfillment'),
      restaurant: noZones,
    });
    expect(added.conversation.cart.fulfillment).toBe('pickup');
    expect(added.reply).not.toMatch(/pickup or delivery/i);
    const delivery = turn(added.conversation, 'delivery please', {
      actions: [{ type: 'set_details', fulfillment: 'delivery' }],
      restaurant: noZones,
    });
    expect(delivery.traces).toContain('validation_failed:set_details');
    expect(delivery.reply).toBe('This restaurant currently offers pickup only.');
    const zone = turn(added.conversation, 'Gulberg', {
      actions: [{ type: 'set_details', zone: 'Gulberg' }],
      restaurant: noZones,
    });
    expect(zone.reply).not.toContain('We deliver to: .');
    const asked = turn(added.conversation, 'review', { restaurant: noZones });
    expect(asked.reply).toContain('What name should I put on the order?');
    expect(asked.reply).not.toMatch(/pickup or delivery/i);
    const named = turn(asked.conversation, '', {
      action: { type: 'set_details', customerName: 'Ali' },
      restaurant: noZones,
    });
    expect(turn(named.conversation, 'confirm', { restaurant: noZones }).order).toMatchObject({
      fulfillment: 'pickup',
      total: 45000,
    });
  });

  it('asks for the area straight away when delivery is the only option', () => {
    const added = turn(fresh(), '1 chicken biryani', { restaurant: deliveryOnly() });
    expect(added.conversation.cart.fulfillment).toBe('delivery');
    const named = turn(added.conversation, '', {
      action: { type: 'set_details', customerName: 'Ali' },
      restaurant: deliveryOnly(),
    });
    expect(named.reply).toContain('Which delivery area? Gulberg, Model Town, DHA.');
  });

  it('says chat ordering is unavailable instead of an empty area list', () => {
    const none = deliveryOnly([]);
    let c = turn(fresh(), '1 chicken biryani', { restaurant: none }).conversation;
    c = turn(c, '', {
      action: { type: 'set_details', customerName: 'Ali' },
      restaurant: none,
    }).conversation;
    const review = turn(c, 'review', { restaurant: none });
    expect(review.reply).toContain('Ordering in this chat is not available right now.');
    expect(review.reply).not.toContain('Which delivery area? .');
    const zone = turn(c, '', {
      action: { type: 'set_details', zone: 'Gulberg' },
      restaurant: none,
    });
    expect(zone.reply).not.toContain('We deliver to: .');
    expect(turn(c, 'confirm', { restaurant: none }).order).toBeUndefined();
  });

  it('still asks pickup or delivery when both are offered', () => {
    const c = turn(fresh(), '1 chicken biryani').conversation;
    expect(c.cart.fulfillment).toBeUndefined();
    expect(turn(c, 'review').reply).toContain('Would you like pickup or delivery?');
  });
});

describe('G7.5: a review while closed is not confirmable', () => {
  const closed: Company = { ...company, openingHours: { start: '09:00', end: '10:00', days: [] } };

  it('shows the order with the closed notice and leaves the cart building', () => {
    const c = reviewed(closed);
    const reply = c.messages.at(-1)!.text;
    expect(reply).toContain('Please review your order:');
    expect(reply).toContain(
      'We are currently closed. Ordering hours are 09:00–10:00. Your cart is saved. Send “review” when we are open.',
    );
    expect(reply).not.toContain('Reply “confirm”');
    expect(c.cart.status).toBe('building');
    expect(c.cart.reviewedRevision).toBeUndefined();
    expect(turn(c, 'confirm', { restaurant: closed }).order).toBeUndefined();
    // Once open, "confirm" shows a fresh review before anything is placed.
    const open = turn(c, 'confirm');
    expect(open.order).toBeUndefined();
    expect(open.traces).toContain('fresh_confirmation_required');
    expect(turn(open.conversation, 'confirm').order).toBeDefined();
  });

  it('says it in the customer’s language', () => {
    const roman = { ...closed, bot: published({ language: 'roman-ur' }) };
    expect(reviewed(roman).messages.at(-1)!.text).toContain(
      'Cart save hai. Jab hum khule hon to “review” likhein.',
    );
    const urdu = { ...closed, bot: published({ language: 'ur' }) };
    expect(reviewed(urdu).messages.at(-1)!.text).toContain('ہمارے کھلنے پر “جائزہ” لکھیں۔');
  });

  it('answers an unclear confirm while closed with the closed review only', () => {
    const c = turn(fresh(), '2 chicken biryani', { restaurant: closed }).conversation;
    const named = turn(c, '', {
      action: { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
      restaurant: closed,
    }).conversation;
    const result = turn(named, 'what is the total?', {
      actions: [{ type: 'confirm' }],
      response: model(),
      restaurant: closed,
    });
    expect(result.order).toBeUndefined();
    expect(result.reply).not.toContain('explicitly reply');
    expect(result.reply).toContain('Send “review” when we are open.');
    expect(result.conversation.cart.status).toBe('building');
  });

  it('takes back a review made while open once a confirm finds the restaurant closed', () => {
    const c = reviewed();
    const refused = turn(c, 'confirm', { restaurant: closed });
    expect(refused.reply).toBe(
      'We are currently closed. Ordering hours are 09:00–10:00. Your cart is saved.',
    );
    expect(refused.conversation.cart.status).toBe('building');
    const next = turn(refused.conversation, 'haan', { actions: [{ type: 'confirm' }] });
    expect(next.order).toBeUndefined();
  });
});

describe('G7.2: a confirmation processed late is asked again', () => {
  it.each([
    ['a typed confirm', { text: 'confirm', button: false }],
    ['a button tap', { text: 'Confirm order', button: true }],
  ])('turns %s into a fresh review with an apology', (_, { text, button }) => {
    const c = reviewed();
    const result = turn(c, text, {
      action: button ? { type: 'confirm', revision: c.cart.revision } : undefined,
      extra: { late: true },
    });
    expect(result.order).toBeUndefined();
    expect(result.traces).toContain('fresh_confirmation_required');
    expect(result.reply).toContain('Sorry for the delay. Please confirm your order again.');
    expect(result.reply).toContain('Please review your order:');
    expect(result.conversation.mode).toBe('bot');
    expect(turn(result.conversation, 'confirm').order).toBeDefined();
  });

  it('apologises in Roman Urdu too', () => {
    const roman = { ...company, bot: published({ language: 'roman-ur' }) };
    const result = turn(reviewed(roman), 'haan', { restaurant: roman, extra: { late: true } });
    expect(result.reply).toContain('Der ke liye maazrat.');
  });
});
