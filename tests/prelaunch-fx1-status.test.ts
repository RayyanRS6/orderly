import { describe, expect, it } from 'vitest';
import {
  asksOrderStatus,
  createConversation,
  orderStatusText,
  orderStillCurrent,
  processTurn,
} from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Company,
  Conversation,
  Language,
  ModelResponse,
  TurnInput,
} from '../src/shared/types';

// Wednesday 9 September 2026, 18:30 in Karachi.
const now = '2026-09-09T13:30:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60000).toISOString();
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
// Open 12:00–23:00 Karachi time: 02:30 on Thursday (8 hours after `now`) is closed.
const hours = (days = [0, 1, 2, 3, 4, 5, 6]): Company => ({
  ...company,
  openingHours: { start: '12:00', end: '23:00', days },
});
const inLanguage = (restaurant: Company, language: Language): Company => ({
  ...restaurant,
  bot: {
    draft: { ...defaultBot, language },
    revision: 1,
    history: [],
    published: {
      version: 1,
      config: { ...defaultBot, language },
      publishedAt: now,
      publishedBy: 'test',
    },
  },
});
const fresh = () => createConversation(company.id, '923000000099', 'demo', now);
let message = 0;
function turn(
  restaurant: Company,
  c: Conversation,
  text: string,
  when: string,
  actions?: BotAction[],
  response?: ModelResponse,
  extra: Partial<TurnInput> = {},
) {
  return processTurn(
    restaurant,
    products,
    c,
    { messageId: `fx1-status-${++message}`, text, now: when, ...extra },
    actions,
    response,
  );
}

describe('Order status answers only a current order, in natural time', () => {
  const order = (status: NonNullable<TurnInput['latestOrder']>['status'], minutes: number) => ({
    reference: 'ORD-1234ABCD',
    status,
    fulfillment: 'pickup' as const,
    createdAt: ago(minutes + 30),
    updatedAt: ago(minutes),
  });
  function placed() {
    const c = fresh();
    c.cart = {
      ...c.cart,
      items: [{ productId: biryani.id, quantity: 1, modifierIds: [], notes: '' }],
      fulfillment: 'pickup',
      customerName: 'Ali',
      status: 'submitted',
      orderId: 'order-1',
    };
    return c;
  }
  const ask = (text: string, latestOrder: ReturnType<typeof order>) =>
    turn(
      company,
      placed(),
      text,
      now,
      [{ type: 'answer', text: '' }],
      { text: 'Delivery usually takes 40 minutes.', askFor: 'none' },
      { latestOrder },
    );

  it('answers “how long” wording with an order still in progress or just finished', () => {
    expect(ask('kitni der mein delivery hoti hai?', order('pending', 10)).traces).toContain(
      'order_status',
    );
    expect(ask('any update on my food?', order('rejected', 90)).traces).toContain('order_status');
  });

  it('leaves a returning customer’s question to the usual flow', () => {
    for (const [text, latest] of [
      ['kitni der mein delivery hoti hai?', order('completed', 3 * 24 * 60)],
      ['how long does delivery take to Gulberg?', order('completed', 3 * 60)],
      ['Gulberg delivery kitni der mein?', order('cancelled', 5 * 60)],
      ['kitna time lagta hai?', order('accepted', 30 * 60)],
    ] as const) {
      const result = ask(text, latest);
      expect(result.traces, text).not.toContain('order_status');
      expect(result.reply, text).toBe('Delivery usually takes 40 minutes.');
    }
  });

  it('does not read menu questions as status questions', () => {
    for (const text of [
      'how long is the seekh kebab?',
      'any update on the menu?',
      'how long are you open today?',
    ])
      expect(asksOrderStatus(text, order('pending', 5), now), text).toBe(false);
  });

  it('still answers a question that names the order, whatever its age', () => {
    const result = ask('where is my order?', order('completed', 2 * 24 * 60));
    expect(result.reply).toBe(
      'Order ORD-1234ABCD is completed. Send “new order” to order again.\nLast update: about 2 days ago.',
    );
    expect(asksOrderStatus('kitni der?')).toBe(true);
    expect(asksOrderStatus('kitni der mein delivery hoti hai?')).toBe(false);
  });

  it('knows which orders are current', () => {
    expect(orderStillCurrent(order('pending', 23 * 60), now)).toBe(true);
    expect(orderStillCurrent(order('pending', 25 * 60), now)).toBe(false);
    expect(orderStillCurrent(order('completed', 119), now)).toBe(true);
    expect(orderStillCurrent(order('completed', 121), now)).toBe(false);
  });

  it.each([
    ['en', 75, 'Last update: about an hour ago.'],
    ['en', 3 * 60 + 10, 'Last update: about 3 hours ago.'],
    ['en', 26 * 60, 'Last update: about a day ago.'],
    ['en', 3 * 24 * 60, 'Last update: about 3 days ago.'],
    ['ur', 75, 'آخری اپڈیٹ: تقریباً ایک گھنٹہ پہلے۔'],
    ['ur', 5 * 60, 'آخری اپڈیٹ: تقریباً 5 گھنٹے پہلے۔'],
    ['ur', 2 * 24 * 60, 'آخری اپڈیٹ: تقریباً 2 دن پہلے۔'],
    ['roman-ur', 5 * 60, 'Aakhri update: taqreeban 5 ghante pehle.'],
    ['roman-ur', 26 * 60, 'Aakhri update: taqreeban ek din pehle.'],
    ['en', 45, 'Last update: 45 minutes ago.'],
  ] as const)('in %s, %i minutes reads “%s”', (lang, minutes, expected) => {
    expect(orderStatusText(lang, order('preparing', minutes), now).split('\n')[1]).toBe(expected);
  });

  it('points a placed order’s customer to the status question, not to staff', () => {
    const result = turn(
      company,
      placed(),
      '1 chicken biryani aur',
      now,
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      { text: 'Anything else?', askFor: 'anything_else' },
    );
    expect(result.reply).toContain(
      'This order has already been submitted. Ask “where is my order?” for its status, or send “new order” to start another.',
    );
  });
});
