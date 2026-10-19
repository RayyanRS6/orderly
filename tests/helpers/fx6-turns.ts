// Turns through the engine for the fx-6 tests (tests/prelaunch-fx6-*.test.ts): the demo
// restaurant, a bot setting helper, and a placed order with the status staff gave it.
import { createConversation, processTurn } from '../../src/domain/engine';
import { defaultBot } from '../../src/shared/bot';
import { seedCompanies, seedProducts } from '../../src/shared/seed';
import type {
  BotAction,
  BotConfig,
  Company,
  Conversation,
  Language,
  ModelResponse,
  Order,
  TurnInput,
} from '../../src/shared/types';

// Wednesday 9 September 2026, 18:30 in Karachi.
export const now = '2026-09-09T13:30:00.000Z';
export const at = (hours: number) => new Date(Date.parse(now) + hours * 3600000).toISOString();
export const company = seedCompanies[0]!;
export const products = seedProducts.filter((p) => p.companyId === company.id);
export const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
// What the linked phone sends when a customer's message never reached it.
export const UNREAD =
  'Customer sent a message Orderly could not read on the linked phone. Check the restaurant phone. Staff assistance requested.';
export const withBot = (restaurant: Company, changes: Partial<BotConfig>): Company => ({
  ...restaurant,
  bot: {
    draft: { ...defaultBot, ...changes },
    revision: 1,
    history: [],
    published: {
      version: 1,
      config: { ...defaultBot, ...changes },
      publishedAt: now,
      publishedBy: 'test',
    },
  },
});
// Open 12:00–23:00 Karachi time.
export const hours: Company = {
  ...company,
  openingHours: { start: '12:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] },
};
export const fresh = (language: Language = 'en'): Conversation => ({
  ...createConversation(company.id, '923000000164', 'demo', now),
  language,
});
let message = 0;
export function turn(
  restaurant: Company,
  c: Conversation,
  text: string,
  extra: Partial<TurnInput> = {},
  actions?: BotAction[],
  response?: ModelResponse,
  catalog = products,
) {
  return processTurn(
    restaurant,
    catalog,
    c,
    { messageId: `fx6-turn-${++message}`, text, now, ...extra },
    actions,
    response,
  );
}
export const step = (restaurant: Company, c: Conversation, action: BotAction, text = 'step') =>
  turn(restaurant, c, text, { action }).conversation;
export function reviewed(restaurant: Company, language: Language = 'en') {
  let c = fresh(language);
  c = step(restaurant, c, { type: 'add_item', productId: biryani.id, quantity: 2 });
  c = step(restaurant, c, { type: 'set_details', customerName: 'Ali', fulfillment: 'pickup' });
  return step(restaurant, c, { type: 'review' });
}
export function placed(language: Language = 'en') {
  const result = turn(company, reviewed(company, language), 'confirm', {
    action: { type: 'confirm' },
  });
  return { conversation: result.conversation, order: result.order! };
}
// The order as the server passes it to the engine, with the status and time staff left it at.
export const latest = (order: Order, status: Order['status'], updatedAt: string) => ({
  reference: order.reference,
  status,
  fulfillment: order.fulfillment,
  createdAt: order.createdAt,
  updatedAt,
});
