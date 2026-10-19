// Final review, fx-6 (conversation-4, customer-wording-2/4/5): the AI never says a payment was
// received, before or after the order; a true answer that the restaurant takes a payment method
// is kept; and the order confirmation tells a customer who wants to transfer how to get the
// restaurant's details.
import { describe, expect, it } from 'vitest';
import { createConversation, orderReceivedText, processTurn } from '../src/domain/engine';
import { isStaffRequest } from '../src/domain/disclosure';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Company,
  Conversation,
  ModelResponse,
  PaymentMethod,
} from '../src/shared/types';

// Wednesday 9 September 2026, 18:30 in Karachi (the demo restaurant is open all day).
const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const taking = (methods: PaymentMethod[]): Company => ({ ...company, paymentMethods: methods });
const transfers = taking(['cash', 'jazzcash', 'easypaisa']);
let message = 0;
function turn(
  restaurant: Company,
  c: Conversation,
  text: string,
  actions?: BotAction[],
  response?: ModelResponse,
  action?: BotAction,
) {
  return processTurn(
    restaurant,
    products,
    c,
    { messageId: `fx6-payment-${++message}`, text, now, ...(action && { action }) },
    actions,
    response,
  );
}
const answer: BotAction[] = [{ type: 'answer', text: '' }];
const says = (text: string): ModelResponse => ({ text, askFor: 'none' });
function reviewed(restaurant: Company) {
  let c = createConversation(company.id, '923000000163', 'demo', now);
  for (const action of [
    { type: 'add_item', productId: biryani.id, quantity: 2 },
    { type: 'set_details', customerName: 'Ali', fulfillment: 'pickup' },
    { type: 'review' },
  ] as BotAction[])
    c = turn(restaurant, c, 'step', undefined, undefined, action).conversation;
  return c;
}
function submitted(restaurant: Company) {
  const placed = turn(restaurant, reviewed(restaurant), 'confirm', undefined, undefined, {
    type: 'confirm',
  });
  expect(placed.order).toBeDefined();
  return placed.conversation;
}

const PAYMENT_CLAIMS = [
  'Shukriya! Aap ki payment receive ho gayi hai.',
  'Thank you, your payment has been received.',
  'Thanks! Payment received.',
  'شکریہ، آپ کی ادائیگی وصول ہو گئی ہے۔',
  'آپ کی ادائیگی موصول ہو گئی ہے۔ شکریہ',
  'آپ کی ادائیگی مل گئی ہے',
  'Aap ki payment submit ho gayi hai.',
  'Payment receive ho gayi, order jaldi aa jayega.',
  'Payment mil gayi hai, shukriya',
  'Your payment is verified.',
  'Your transfer has been received.',
  'JazzCash payment received, thanks!',
  'We have received your payment.',
  'We got your payment',
  'Your JazzCash payment is accepted.',
];

describe('fx-6: the AI never says a payment was received', () => {
  it.each(PAYMENT_CLAIMS)('drops “%s” once the order is placed', (text) => {
    const result = turn(
      transfers,
      submitted(transfers),
      'maine jazzcash kar diya hai',
      answer,
      says(text),
    );
    expect(result.reply).not.toContain(text);
    expect(result.decision?.modelText).toBe('unsafe');
    expect(result.decision?.corrections).toContain('unsafe_model_response_ignored');
  });

  it.each(PAYMENT_CLAIMS)('drops “%s” before the order too', (text) => {
    const result = turn(transfers, reviewed(transfers), 'jazzcash kar diya', answer, says(text));
    expect(result.reply).not.toContain(text);
    expect(result.order).toBeUndefined();
  });

  it.each([
    'I have placed an additional order for 2 naan.',
    'Your extra naan has been placed in the order.',
  ])('never says more was ordered after the order: “%s”', (text) => {
    const result = turn(transfers, submitted(transfers), '2 naan aur', answer, says(text));
    expect(result.reply).not.toContain(text);
  });

  it.each([
    'Shukriya! Order receive ho gaya, restaurant jald accept karega.',
    'Your order has been placed.',
    'Your order has been received.',
    'Aap ka message mil gaya.',
    'Payment cash hogi.',
    'The restaurant will confirm once they have received the transfer.',
    'Got it, your payment will be cash at pickup.',
    'Payment will be received at pickup.',
    'Your order has been placed. Want to place another order later? Send “new order”.',
    'Aap ka order 45 minute mein deliver kar diya jayega.',
    'آپ کا آرڈر 45 منٹ میں ڈیلیور کر دیا جائے گا۔',
  ])('keeps a true or future statement after the order: “%s”', (text) => {
    const result = turn(transfers, submitted(transfers), 'thanks', answer, says(text));
    expect(result.reply).toBe(text);
    expect(result.conversation.mode).toBe('bot');
  });
});

describe('fx-6: a true answer about the restaurant’s payment methods is kept', () => {
  it.each([
    ['jazzcash chalta hai?', 'Ji haan, JazzCash accepted hai.'],
    ['do you take easypaisa?', 'Yes, Easypaisa payments are accepted.'],
    ['jazzcash ya easypaisa?', 'JazzCash and Easypaisa are both accepted.'],
    ['cash on delivery?', 'Yes, cash on delivery is accepted.'],
  ])('“%s” → “%s”', (text, modelText) => {
    const result = turn(transfers, reviewed(transfers), text, answer, says(modelText));
    expect(result.reply).toBe(modelText);
    expect(result.conversation.mode).toBe('bot');
    expect(result.traces).not.toContain('handoff');
  });

  it('drops it for a method the restaurant does not take, and keeps order outcomes out', () => {
    const cashOnly = turn(
      company,
      reviewed(company),
      'do you take jazzcash?',
      answer,
      says('Yes, JazzCash is accepted.'),
    );
    expect(cashOnly.reply).not.toContain('JazzCash is accepted');
    expect(cashOnly.decision?.corrections).toContain('unsafe_model_response_ignored');
    const order = turn(
      transfers,
      reviewed(transfers),
      'jazzcash?',
      answer,
      says('JazzCash is accepted and your order is accepted too.'),
    );
    expect(order.reply).not.toContain('your order is accepted');
  });
});

describe('fx-6: the confirmation says how a transfer reaches the restaurant', () => {
  it('tells the customer to type “staff”, which reaches a person', () => {
    const placed = turn(transfers, reviewed(transfers), 'confirm', undefined, undefined, {
      type: 'confirm',
    });
    const order = placed.order!;
    expect(placed.reply).toBe(
      `Order ${order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment: cash at pickup, or JazzCash / Easypaisa — to pay by transfer, type “staff” here and restaurant staff will send the payment details and confirm the transfer themselves.`,
    );
    expect(orderReceivedText('ur', order, ['jazzcash'])).toContain(
      'ٹرانسفر کے لیے ریسٹورنٹ کی ادائیگی کی تفصیل یہاں “عملہ” لکھ کر منگوائیں، عملہ ٹرانسفر کی تصدیق خود کرے گا۔',
    );
    expect(orderReceivedText('roman-ur', order, ['cash', 'bank_transfer'])).toContain(
      'Transfer ke liye yahan “staff” likhein, restaurant ka staff payment details bhejega aur transfer khud confirm karega.',
    );
    // Cash only keeps its words.
    expect(orderReceivedText('en', order, ['cash'])).toBe(
      `Order ${order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment is cash at pickup.`,
    );
    // The words it asks for reach staff.
    expect(isStaffRequest('staff')).toBe(true);
    expect(isStaffRequest('عملہ')).toBe(true);
    const asked = turn(transfers, placed.conversation, 'staff');
    expect(asked.traces).toContain('handoff');
    expect(asked.conversation.mode).toBe('human');
  });
});
