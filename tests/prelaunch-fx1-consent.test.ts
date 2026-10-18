import { describe, expect, it } from 'vitest';
import {
  asksToCancelOrder,
  createConversation,
  parseActions,
  processTurn,
} from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const roman: Company = {
  ...company,
  bot: {
    draft: { ...defaultBot, language: 'roman-ur' },
    revision: 1,
    history: [],
    published: {
      version: 1,
      config: { ...defaultBot, language: 'roman-ur' },
      publishedAt: now,
      publishedBy: 'test',
    },
  },
};
const fresh = () => createConversation(company.id, '923000000093', 'demo', now);
let message = 0;
function turn(c: Conversation, text: string, restaurant = company, action?: BotAction, at = now) {
  return processTurn(restaurant, products, c, {
    messageId: `fx1-consent-${++message}`,
    text,
    now: at,
    action,
  });
}
function reviewed(restaurant = company) {
  let c = turn(fresh(), '2 chicken biryani', restaurant).conversation;
  c = turn(c, '', restaurant, {
    type: 'set_details',
    fulfillment: 'pickup',
    customerName: 'Ali',
  }).conversation;
  expect(c.cart.status).toBe('awaiting_confirmation');
  return c;
}

describe('F34: “confirm karein” and its spellings place a reviewed order', () => {
  it.each([
    'confirm karein',
    'confirm karen',
    'confirm krein',
    'confirm kren',
    'confirm krden',
    'confirm kr den',
    'confirm kijiye',
    'confirm kariye',
    'confirm kar dijiyega',
    'confirm kar lein',
    'order confirm karein',
    'haan confirm karein',
    'ji confirm karein please',
  ])('“%s” is consent', (text) => {
    expect(parseActions(company, products, reviewed(), text)).toEqual([{ type: 'confirm' }]);
    expect(turn(reviewed(), text).order).toBeDefined();
  });

  it.each(['confirm karein?', 'confirm mat karein', 'confirm nahi karein'])(
    '“%s” is not consent',
    (text) => {
      expect(turn(reviewed(), text).order).toBeUndefined();
    },
  );

  it('accepts the customer echoing the bot’s own “confirm karein”', () => {
    // A confirm more than an hour after the review asks again, in the bot's words.
    const later = new Date(Date.parse(now) + 61 * 60000).toISOString();
    const asked = turn(reviewed(roman), 'confirm', roman, undefined, later);
    expect(asked.traces).toContain('fresh_confirmation_required');
    expect(asked.reply).toContain('Neeche di gayi maujooda details confirm karein.');
    const placed = turn(asked.conversation, 'confirm karein', roman, undefined, later);
    expect(placed.order).toBeDefined();
    expect(placed.traces).toContain('order_pending_restaurant_acceptance');
  });
});

describe('F36: “cancel karein” and its spellings ask to cancel', () => {
  it.each([
    'cancel karein',
    'cancel karen',
    'cancel kren',
    'cancel kr den',
    'cancel krden',
    'cancel kijiye',
    'cancel kariye',
    'order cancel karein',
    'mera order cancel karen',
    'order cancel kar lein please',
    'آرڈر منسوخ کیجیے',
  ])('recognises “%s”', (text) => {
    expect(asksToCancelOrder(text)).toBe(true);
    expect(parseActions(company, products, fresh(), text)).toEqual([{ type: 'cancel' }]);
  });

  it.each(['cancel mat karein', 'cancel nahi karein', 'kya cancel karein?', 'cancel karein raita'])(
    'does not treat “%s” as a cancellation',
    (text) => {
      expect(asksToCancelOrder(text)).toBe(false);
    },
  );
});
