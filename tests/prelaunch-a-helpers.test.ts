import { describe, expect, it } from 'vitest';
import {
  aiErrorNotice,
  asksOrderStatus,
  asksToCancelOrder,
  createConversation,
  emptyCart,
  limitNotice,
  orderSafetyLine,
  orderStatusText,
  parseActions,
  processTurn,
} from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Cart, Company, Conversation, Language, TurnInput } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60000).toISOString();
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const fresh = () => createConversation(company.id, '923000000055', 'demo', now);
let message = 0;

describe('F36: one recogniser for a request to cancel the order', () => {
  it.each([
    'cancel',
    'Cancel.',
    'cancel!',
    'cancel order',
    'cancel my order',
    'please cancel my order',
    'pls cancel the order',
    'cancel karo',
    'cancel kar do',
    'cancel kardo',
    'cancel kar dein',
    'cancel kar dain please',
    'cancel kr do',
    'cancel kar dijiye',
    'order cancel',
    'my order cancel karo',
    'order cancel kar dein please',
    'mera order cancel kar do',
    'منسوخ',
    'آرڈر منسوخ',
    'آرڈر منسوخ کر دیں',
    'میرا آرڈر منسوخ کریں',
    'آرڈر کینسل کر دو',
  ])('recognises “%s”', (text) => {
    expect(asksToCancelOrder(text)).toBe(true);
    expect(parseActions(company, products, fresh(), text)).toEqual([{ type: 'cancel' }]);
  });

  it.each([
    "don't cancel",
    'do not cancel my order',
    'cancel mat karo',
    'cancel nahi karna',
    'cancel the raita',
    'cancel 1 naan',
    'can I cancel later?',
    'I want to add naan, not cancel',
    'منسوخ نہ کریں',
  ])('does not treat “%s” as a cancellation', (text) => {
    expect(asksToCancelOrder(text)).toBe(false);
  });
});

describe('G7.6: notices say whether the order is safe', () => {
  const placed: Cart = { ...emptyCart(), status: 'submitted', orderId: 'order-1', items: [] };
  const building: Cart = {
    ...emptyCart(),
    items: [{ productId: products[0]!.id, quantity: 1, modifierIds: [], notes: '' }],
  };
  it.each([
    ['en', 'Your order is not affected.', 'Your order hasn’t been placed yet.'],
    ['ur', 'آپ کے آرڈر پر کوئی اثر نہیں پڑا۔', 'آپ کا آرڈر ابھی نہیں دیا گیا۔'],
    ['roman-ur', 'Aap ke order par koi asar nahi para.', 'Aap ka order abhi place nahi hua.'],
  ] as const)('in %s', (lang, safe, notYet) => {
    expect(orderSafetyLine(lang, { ...building, orderId: 'order-1' })).toBe(safe);
    expect(orderSafetyLine(lang, placed)).toBe(safe);
    expect(orderSafetyLine(lang, building)).toBe(notYet);
    expect(orderSafetyLine(lang, emptyCart())).toBe('');
    expect(aiErrorNotice(lang, placed).endsWith(` ${safe}`)).toBe(true);
    expect(aiErrorNotice(lang, emptyCart())).not.toContain(safe);
    expect(limitNotice(lang, placed).endsWith(` ${safe}`)).toBe(true);
  });
  it('never tells a customer with a placed order that it was not submitted', () => {
    const text = aiErrorNotice('en', placed);
    expect(text).toBe(
      'I’m having trouble connecting right now. A staff member will reply here soon. Your order is not affected.',
    );
    expect(text).not.toMatch(/not (?:been )?submitted|hasn’t been placed/);
    expect(limitNotice('en', building)).toBe(
      'Thanks for your message! Our team will reply here soon. Your order hasn’t been placed yet.',
    );
  });
});

describe('G3.10/G7.9: the engine answers “where is my order?”', () => {
  function submitted(lang?: Language) {
    const restaurant: Company = lang
      ? {
          ...company,
          bot: {
            draft: { ...defaultBot, language: lang },
            revision: 1,
            history: [],
            published: {
              version: 1,
              config: { ...defaultBot, language: lang },
              publishedAt: now,
              publishedBy: 'test',
            },
          },
        }
      : company;
    const c = fresh();
    c.cart = {
      ...c.cart,
      items: [{ productId: products[0]!.id, quantity: 1, modifierIds: [], notes: '' }],
      fulfillment: 'pickup',
      customerName: 'Ali',
      status: 'submitted',
      orderId: 'order-1',
    };
    return { restaurant, c };
  }
  const latest = (status: NonNullable<TurnInput['latestOrder']>['status']) => ({
    reference: 'ORD-1234ABCD',
    status,
    fulfillment: 'pickup' as const,
    createdAt: ago(30),
    updatedAt: ago(12),
  });
  const ask = (
    text: string,
    status: NonNullable<TurnInput['latestOrder']>['status'] = 'preparing',
    lang?: Language,
    conversation?: Conversation,
  ) => {
    const { restaurant, c } = submitted(lang);
    return processTurn(
      restaurant,
      products,
      conversation ?? c,
      { messageId: `status-${++message}`, text, now, latestOrder: latest(status) },
      [{ type: 'answer', text: '' }],
      { text: 'Your order has been accepted and is on its way!', askFor: 'none' },
    );
  };

  it.each([
    [
      'where is my order?',
      'en',
      'The restaurant has accepted order ORD-1234ABCD and it is being prepared now.\nLast update: 12 minutes ago.',
    ],
    [
      'mera order kahan hai?',
      'roman-ur',
      'Restaurant ne order ORD-1234ABCD accept kar liya hai aur ab yeh tayyar ho raha hai.\nAakhri update: 12 minute pehle.',
    ],
    [
      'میرا آرڈر کہاں ہے؟',
      'ur',
      'ریسٹورنٹ نے آرڈر ORD-1234ABCD منظور کر لیا ہے اور یہ اب تیار ہو رہا ہے۔\nآخری اپڈیٹ: 12 منٹ پہلے۔',
    ],
  ] as const)('“%s” gets the real status in %s', (text, lang, expected) => {
    const result = ask(text, 'preparing', lang);
    expect(result.reply).toBe(expected);
    expect(result.conversation.mode).toBe('bot');
    expect(result.traces).toContain('order_status');
    expect(result.decision?.modelText).toBe('protected');
    expect(result.decision?.parts).toEqual(['engine']);
  });

  it('words every status truthfully', () => {
    expect(ask('order status').reply).toContain(
      'The restaurant has accepted order ORD-1234ABCD and it is being prepared now.',
    );
    expect(ask('kitni der?', 'pending').reply).toContain(
      'Order ORD-1234ABCD is waiting for the restaurant to accept it.',
    );
    expect(ask('is it ready?', 'ready').reply).toContain('Order ORD-1234ABCD is ready for pickup.');
    expect(ask('any update?', 'cancelled').reply).toContain(
      'Order ORD-1234ABCD was cancelled. Send “new order” to order again.',
    );
    expect(
      orderStatusText('en', { ...latest('out_for_delivery'), fulfillment: 'delivery' }, now),
    ).toBe('Order ORD-1234ABCD is out for delivery.\nLast update: 12 minutes ago.');
    expect(orderStatusText('en', { ...latest('accepted'), updatedAt: now }, now)).toBe(
      'The restaurant has accepted order ORD-1234ABCD.\nLast update: just now.',
    );
  });

  it('leaves other questions, and chats without a placed order, to the usual flow', () => {
    // "How long" wording is about the order only while it is current (fx-1).
    expect(asksOrderStatus('kitni der mein delivery hoti hai?', latest('pending'), now)).toBe(true);
    expect(asksOrderStatus('kitni der mein delivery hoti hai?')).toBe(false);
    const building = fresh();
    building.cart.items = [{ productId: products[0]!.id, quantity: 1, modifierIds: [], notes: '' }];
    const preOrder = ask('kitni der mein delivery hoti hai?', 'completed', undefined, building);
    expect(preOrder.traces).not.toContain('order_status');
    const { restaurant, c } = submitted();
    const noSnapshot = processTurn(
      restaurant,
      products,
      c,
      { messageId: `status-${++message}`, text: 'where is my order?', now },
      [{ type: 'answer', text: '' }],
      { text: 'Let me check.', askFor: 'none' },
    );
    expect(noSnapshot.traces).not.toContain('order_status');
    expect(asksOrderStatus('do you deliver to DHA?')).toBe(false);
    expect(asksOrderStatus('aap kahan hain?')).toBe(false);
  });
});
