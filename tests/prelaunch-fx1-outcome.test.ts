import { describe, expect, it } from 'vitest';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, ModelResponse } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const fresh = () => createConversation(company.id, '923000000095', 'demo', now);
let message = 0;
function turn(
  restaurant: Company,
  text: string,
  actions: BotAction[] | undefined,
  response?: ModelResponse,
  c: Conversation = fresh(),
) {
  return processTurn(
    restaurant,
    products,
    c,
    { messageId: `fx1-outcome-${++message}`, text, now },
    actions,
    response,
  );
}
const answer: BotAction[] = [{ type: 'answer', text: '' }];
const says = (text: string): ModelResponse => ({ text, askFor: 'none' });
function reviewed() {
  let c = turn(company, '2 chicken biryani', undefined).conversation;
  c = processTurn(company, products, c, {
    messageId: `fx1-outcome-${++message}`,
    text: '',
    now,
    action: { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
  }).conversation;
  return c;
}

describe('F07: a polite request in Urdu is not an outcome claim', () => {
  it.each([
    'آرڈر کنفرم کر دیں',
    'آرڈر کنفرم کر دیجیے',
    'سب ٹھیک ہو تو آرڈر کی تصدیق کر دیجئے۔',
    'آرڈر بک کر لیں',
    'آرڈر کنفرم کر لیجیے',
    'Order confirm kar di jiye?',
  ])('keeps “%s” after a review, with the bot', (text) => {
    const result = turn(company, 'ok?', answer, says(text), reviewed());
    expect(result.reply).toBe(text);
    expect(result.decision?.modelText).toBe('used');
    expect(result.conversation.mode).toBe('bot');
  });

  it.each([
    'آپ کا آرڈر کنفرم کر دیا گیا ہے۔',
    'آپ کا آرڈر بک ہو گیا ہے',
    'آرڈر کنفرم ہوگیا',
    'آپ کا آرڈر پلیس ہو گیا ہے',
    'Your order has been placed!',
  ])('still drops “%s” before the order is placed', (text) => {
    const result = turn(company, 'ok?', answer, says(text), reviewed());
    expect(result.reply).not.toContain(text);
    expect(result.order).toBeUndefined();
  });

  it('lets the AI say a submitted order was placed, never that it was confirmed', () => {
    const submitted = processTurn(company, products, reviewed(), {
      messageId: `fx1-outcome-${++message}`,
      text: 'confirm',
      now,
    }).conversation;
    expect(submitted.cart.status).toBe('submitted');
    for (const text of [
      'Shukriya! Aap ka order place ho gaya hai.',
      'Your order has been placed, thank you!',
      'شکریہ! آپ کا آرڈر پلیس ہو گیا ہے۔',
    ]) {
      const thanks = turn(company, 'shukriya', answer, says(text), submitted);
      expect(thanks.reply, text).toBe(text);
      expect(thanks.conversation.mode, text).toBe('bot');
    }
    for (const text of [
      'Aap ka order confirm ho gaya hai.',
      'آپ کا آرڈر بک ہو گیا ہے، شکریہ',
      'Your order is confirmed!',
    ])
      expect(turn(company, 'shukriya', answer, says(text), submitted).reply, text).not.toBe(text);
  });
});
