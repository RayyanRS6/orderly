// "Which one would you like?" before the numbered dishes is asked in the customer's language.
import { describe, expect, it } from 'vitest';
import { createConversation, processTurn } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Language } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const karahi = products.find((p) => p.name === 'Chicken Karahi')!;
const inLanguage = (language: Language): Company => ({
  ...company,
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
let message = 0;
const turn = (restaurant: Company, text: string, action?: BotAction) =>
  processTurn(
    restaurant,
    products,
    createConversation(company.id, `92300000070${++message}`, 'demo', now),
    { messageId: `fx5b-choice-${message}`, text, now, ...(action && { action }) },
  );

describe('the item choice is asked in the customer’s language', () => {
  const choose: BotAction = {
    type: 'clarify_item',
    candidateProductIds: [biryani.id, karahi.id],
    quantity: 2,
  };
  it.each([
    ['en', 'Which one would you like?'],
    ['ur', 'آپ کون سا لینا چاہیں گے؟'],
    ['roman-ur', 'Aap kaun sa lena chahenge?'],
  ] as const)('in %s', (lang, question) => {
    expect(turn(inLanguage(lang), 'chicken', choose).reply).toBe(
      `${question}\n1. Chicken Biryani\n2. Chicken Karahi`,
    );
  });

  it('follows the customer when the bot answers in their language', () => {
    const roman = turn(company, 'mujhe 2 chicken chahiye');
    expect(roman.traces).toContain('clarify_item');
    expect(roman.reply.split('\n')[0]).toBe('Aap kaun sa lena chahenge?');
    const english = turn(company, '2 chicken please');
    expect(english.traces).toContain('clarify_item');
    expect(english.reply.split('\n')[0]).toBe('Which one would you like?');
  });
});
