// Final review, fx-10 (conversation-4, customer-wording-2 and the sweep's P2): after "maine
// jazzcash kar diya" the AI never says the transfer was accepted or received, in any of the
// common wordings, nor that more was ordered after the order went in. A true general statement
// ("Easypaisa payments are accepted", "payments are verified by our staff", "it was submitted")
// is kept.
import { describe, expect, it } from 'vitest';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, ModelResponse } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const transfers: Company = { ...company, paymentMethods: ['cash', 'jazzcash', 'easypaisa'] };
let message = 0;
function turn(c: Conversation, text: string, response?: ModelResponse, action?: BotAction) {
  return processTurn(
    transfers,
    products,
    c,
    { messageId: `fx10-payment-${++message}`, text, now, ...(action && { action }) },
    response && [{ type: 'answer', text: '' }],
    response,
  );
}
const says = (text: string): ModelResponse => ({ text, askFor: 'none' });
function reviewed() {
  let c = createConversation(company.id, '923000000173', 'demo', now);
  for (const action of [
    { type: 'add_item', productId: biryani.id, quantity: 2 },
    { type: 'set_details', customerName: 'Ali', fulfillment: 'pickup' },
    { type: 'review' },
  ] as BotAction[])
    c = turn(c, 'step', undefined, action).conversation;
  return c;
}
function submitted() {
  const placed = turn(reviewed(), 'confirm', undefined, { type: 'confirm' });
  expect(placed.order).toBeDefined();
  return placed.conversation;
}
const refused = (c: Conversation, text: string, modelText: string) => {
  const result = turn(c, text, says(modelText));
  expect(result.reply, modelText).not.toContain(modelText);
  expect(result.decision?.modelText, modelText).toBe('unsafe');
  expect(result.decision?.corrections, modelText).toContain('unsafe_model_response_ignored');
};
const kept = (c: Conversation, text: string, modelText: string) => {
  const result = turn(c, text, says(modelText));
  expect(result.reply, modelText).toBe(modelText);
  expect(result.conversation.mode, modelText).toBe('bot');
};

const CLAIMS = [
  // "accepted" said of this customer's transfer.
  'Thanks! JazzCash payment accepted.',
  'Shukriya! JazzCash accepted.',
  'Easypaisa payment accepted, shukriya!',
  'Ji, JazzCash payment accepted hai.',
  'Shukriya, Easypaisa transfer accepted.',
  'Payment via JazzCash accepted, thank you!',
  'Shukriya! JazzCash payment accepted hai, order jaldi ready hoga.',
  'Thanks! Your payment via JazzCash is accepted.',
  'Thank you, payment through Easypaisa is accepted.',
  'JazzCash transfer accept ho gaya hai.',
  // An order outcome next to a payment method.
  'Your order with cash on delivery is accepted.',
  'Your order paid by JazzCash is accepted.',
  // A condition word in an earlier clause does not make the claim a condition.
  'Thanks! After checking, we have received your payment.',
  'Once again thank you, your payment has been received.',
  // Other wordings of a received payment.
  'Aap ki payment wasool ho gayi hai.',
  'Payment mosool ho gayi.',
  'Adaigi wasool ho gayi.',
  'Payment ho gayi hai, shukriya.',
  'Transfer ho gaya hai, shukriya.',
  'Payment ki tasdeeq ho gayi hai.',
  'ادائیگی ہو گئی ہے۔',
  'آپ کی ادائیگی ہو گئی ہے',
  'پیمنٹ ریسیو ہو گئی',
  'Your payment went through.',
  'Payment successful!',
  'Your transaction has been received.',
  'Payment recieved, thanks!',
];

describe('fx-10: the AI never says this customer’s transfer was accepted or received', () => {
  it.each(CLAIMS)('refuses “%s” once the order is placed', (modelText) => {
    refused(submitted(), 'maine jazzcash kar diya hai', modelText);
  });

  it.each(CLAIMS)('refuses “%s” before the order too', (modelText) => {
    refused(reviewed(), 'maine jazzcash kar diya hai', modelText);
  });

  it('refuses “Order placed, JazzCash accepted.” after the order', () => {
    refused(submitted(), 'maine jazzcash kar diya hai', 'Order placed, JazzCash accepted.');
  });
});

describe('fx-10: the AI never says more was ordered after the order went in', () => {
  it.each([
    'I’ve added the extra naan.',
    'I have added 2 naan to your order.',
    'Your new order has been placed.',
    'Your order for 2 more naan has been placed.',
    'Aap ka naya order place ho gaya hai.',
    'آپ کا نیا آرڈر پلیس ہو گیا ہے۔',
    '2 naan aap ke order mein add kar diye hain.',
  ])('refuses “%s”', (modelText) => {
    refused(submitted(), '2 naan aur', modelText);
  });
});

describe('fx-10: true statements stay with the bot', () => {
  it.each([
    [
      'how does jazzcash work?',
      'JazzCash payments are verified by our staff before your food is prepared.',
    ],
    ['easypaisa?', 'Easypaisa transfers are checked and verified by the restaurant.'],
    ['how do I pay?', 'The restaurant will verify your transfer.'],
    ['maine jazzcash kar diya', 'Your payment is being verified by the restaurant staff.'],
    ['jazzcash chalta hai?', 'Ji haan, JazzCash accepted hai.'],
    ['do you take easypaisa?', 'Yes, Easypaisa payments are accepted.'],
    ['cash on delivery?', 'Yes, cash on delivery is accepted.'],
    ['transfer?', 'Agar payment ho gayi hai to screenshot yahan bhej dein, staff check karega.'],
    ['transfer?', 'Kya aap ki payment ho gayi hai?'],
  ])('before the order: “%s” → “%s”', (text, modelText) => {
    kept(reviewed(), text, modelText);
  });

  it.each([
    'Yes, it was submitted. The restaurant will reply here soon.',
    'Yes! It has been placed, the restaurant will reply here soon.',
    'Yes, your order was submitted.',
    'Your order has been placed, send “new order” to order again.',
    'Shukriya! Aap ka order place ho gaya hai aur jald ready hoga.',
    'Yes, Easypaisa payments are accepted.',
    'Ji haan, JazzCash accepted hai.',
  ])('after the order: “%s”', (modelText) => {
    kept(submitted(), 'did it go through?', modelText);
  });
});
