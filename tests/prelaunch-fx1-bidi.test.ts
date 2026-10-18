import { describe, expect, it } from 'vitest';
import { createConversation, processTurn } from '../src/domain/engine';
import { disclosureLine, needsDisclosure, withDisclosure } from '../src/domain/disclosure';
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
const fresh = () => createConversation(company.id, '923000000098', 'demo', now);
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
    { messageId: `fx1-bidi-${++message}`, text, now: when, ...extra },
    actions,
    response,
  );
}

describe('Urdu notices keep Latin names and phone numbers in order', () => {
  it('starts the Urdu notice right-to-left and isolates a Latin business name', () => {
    const line = disclosureLine('Laziza', 'ur');
    expect(line.startsWith('\u200F\u2068Laziza\u2069 کا خودکار اسسٹنٹ۔')).toBe(true);
    const sent = withDisclosure('Laziza', { messages: [] }, 'مینو یہ ہے۔', 'ur', now);
    expect(sent).toBe(`${line}\n\nمینو یہ ہے۔`);
    expect(
      needsDisclosure(
        { messages: [{ id: 'r1', role: 'assistant', text: sent, createdAt: ago(5) }] },
        now,
      ),
    ).toBe(false);
    expect(disclosureLine('Laziza', 'en')).toBe(
      'Laziza’s automated assistant. Type “staff” anytime to talk to a person.',
    );
  });

  it('isolates the phone number in the Urdu allergy notice only', () => {
    const noAnswer: Company = {
      ...company,
      faqs: company.faqs.filter((f) => f.question !== 'allergy'),
    };
    const urdu = turn(inLanguage(noAnswer, 'ur'), fresh(), 'کیا اس میں انڈا ہے؟', now, [
      { type: 'answer', text: '' },
    ]);
    expect(urdu.reply).toContain('آپ ہمیں \u2066+92 300 000 0001\u2069 پر کال بھی کر سکتے ہیں۔');
    const english = turn(noAnswer, fresh(), 'does it contain nuts?', now, [
      { type: 'answer', text: '' },
    ]);
    expect(english.reply).toContain('You can also call us on +92 300 000 0001.');
  });
});
