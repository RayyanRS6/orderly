import { describe, expect, it } from 'vitest';
import { createConversation, processTurn } from '../src/domain/engine';
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
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
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
const fresh = () => createConversation(company.id, '923000000097', 'demo', now);
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
    { messageId: `fx1-wording-${++message}`, text, now: when, ...extra },
    actions,
    response,
  );
}

describe('Engine wording says what to do next', () => {
  it('tells the customer how to reach a person when chat ordering is off', () => {
    const none: Company = {
      ...inLanguage(company, 'en'),
      deliveryZones: [],
      bot: {
        ...inLanguage(company, 'en').bot!,
        published: {
          ...inLanguage(company, 'en').bot!.published!,
          config: { ...defaultBot, language: 'en', fulfillment: 'delivery' },
        },
      },
    };
    const result = turn(none, fresh(), '1 chicken biryani', now);
    let c = result.conversation;
    c = turn(none, c, '', now, undefined, undefined, {
      action: { type: 'set_details', customerName: 'Ali' },
    }).conversation;
    expect(turn(none, c, 'review', now).reply).toContain(
      'Ordering in this chat is not available right now. Type “staff” to talk to a person.',
    );
  });

  it('says a refused confirmation placed nothing, then shows the review once', () => {
    let c = turn(company, fresh(), '2 chicken biryani', now).conversation;
    c = turn(company, c, '', now, undefined, undefined, {
      action: { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
    }).conversation;
    const result = turn(company, c, 'what is the total?', now, [{ type: 'confirm' }], {
      text: '',
      askFor: 'none',
    });
    expect(result.order).toBeUndefined();
    expect(result.traces).toContain('unconfirmed_model_action_rejected');
    expect(
      result.reply.startsWith('Your order hasn’t been placed yet.\n\nPlease review your order:'),
    ).toBe(true);
    expect(result.reply.split('review your order')).toHaveLength(2);
    expect(result.reply).toContain('Reply “confirm” to submit this order');
  });
});
