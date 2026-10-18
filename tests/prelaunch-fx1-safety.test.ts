import { describe, expect, it } from 'vitest';
import { asksAboutAllergens, createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, ModelResponse } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const allergyFaq = company.faqs.find((f) => f.question === 'allergy')!;
const noAnswer: Company = { ...company, faqs: company.faqs.filter((f) => f !== allergyFaq) };
const fresh = () => createConversation(company.id, '923000000092', 'demo', now);
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
    { messageId: `fx1-safety-${++message}`, text, now },
    actions,
    response,
  );
}
const answer: BotAction[] = [{ type: 'answer', text: '' }];
const says = (text: string): ModelResponse => ({ text, askFor: 'none' });
const notice =
  'We can’t confirm allergens or ingredients in this chat. A staff member will reply here to help you. You can also call us on +92 300 000 0001.';

describe('F09: asking what is on the menu is not an allergy question', () => {
  it.each([
    'fish hai kya?',
    'machli hai kya',
    'machli hai kya aaj?',
    'anday hain kya?',
    'anda hai kya?',
    'prawns hain kya?',
    'jheenga hai kya?',
    'doodh hai kya?',
    'مچھلی ہے کیا؟',
    'آج مچھلی ہے کیا؟',
    'is there any fish?',
    'is there fish today?',
    'is there any fish tikka?',
    'is there fish on the menu?',
    'is there milk shake?',
    'are there any prawns?',
    'any fish in the menu?',
    'any fish on the menu today?',
    'any prawns in the menu?',
    'eggs in stock?',
    'fish in stock?',
    'fish in winter menu?',
    'prawns in garlic sauce?',
    'do you have eggs?',
    'do you have fish?',
    'aaj koi fish nahi?',
    'give me fish?',
  ])('“%s” is answered as usual and stays with the bot', (text) => {
    expect(asksAboutAllergens(text)).toBe(false);
    const result = turn(noAnswer, text, answer, says('Yes, we have Fish Tikka today.'));
    expect(result.reply).toBe('Yes, we have Fish Tikka today.');
    expect(result.conversation.mode).toBe('bot');
    expect(result.traces).not.toContain('allergy_question_guarded');
  });

  it('does not carry a menu question over into the next message', () => {
    const first = turn(company, 'fish hai kya?', answer, says('Ji haan, Fish Tikka hai.'));
    expect(first.reply).toBe('Ji haan, Fish Tikka hai.');
    const next = turn(
      company,
      'biryani kitne ki hai?',
      [{ type: 'menu', query: 'biryani' }],
      says(''),
      first.conversation,
    );
    expect(next.traces).not.toContain('allergy_question_guarded');
    expect(next.reply).not.toContain(allergyFaq.answer);
    expect(next.reply).toContain('Chicken Biryani');
  });
});

describe('F09: the commonest ways of asking what a dish contains are allergy questions', () => {
  it.each([
    'isme nuts hain?',
    'kya ismein peanuts hain?',
    'kya ismein anda hai?',
    'nuts hain is mein?',
    'nuts hai isme?',
    'koi nuts to nahi?',
    'koi anda to nahi?',
    'any nuts?',
    'any peanuts?',
    'nuts?',
    'gluten?',
    'nuts hain?',
    'gluten hai?',
    'koi nuts hain?',
    'koi nuts?',
    'usme doodh hai?',
    'ismein dudh hai?',
    'ismai nuts hain?',
    'biryani mein nuts?',
    'biryani me nuts to nahi?',
    'biryani mein koi nuts to nahi?',
    'anda dala hai?',
    'peanut oil use hota hai?',
    'کیا مونگ پھلی کا تیل استعمال ہوتا ہے؟',
    'is there fish in the biryani?',
    'is there egg in the cake?',
    'any nuts in the korma?',
    'nuts in korma?',
    'بریانی میں انڈا؟',
    'بادام؟',
    'اس میں انڈا ڈالا ہے؟',
  ])('recognises “%s”', (text) => {
    expect(asksAboutAllergens(text)).toBe(true);
  });

  it('gives the fixed notice and a person, never the AI’s “no”', () => {
    for (const [text, modelText] of [
      ['kya ismein peanuts hain?', 'Ji nahi'],
      ['usme doodh hai?', 'Ji nahi'],
      ['nuts?', 'No, our biryani is made with chicken, rice and spices.'],
      ['isme nuts hain?', 'Bilkul, aap kha sakte hain'],
    ] as const) {
      const result = turn(noAnswer, text, answer, {
        text: modelText,
        askFor: 'none',
        groundingIds: [biryani.id],
      });
      expect(result.reply, text).toBe(notice);
      expect(result.conversation.mode, text).toBe('human');
      expect(result.traces, text).toContain('allergy_question_guarded');
    }
  });
});

describe('F09: AI wording that vouches for a dish to someone who named an allergen', () => {
  it.each([
    ['mujhe peanuts se masla hai, biryani le lun?', 'Bilkul, aap kha sakte hain.'],
    ['I can’t have nuts, what do you suggest?', 'Our biryani only has chicken, rice and spices.'],
    ['nuts wali cheez nahi khani, karahi theek hai?', 'Yes, totally fine for you.'],
    ['mujhe dairy nahi chahiye, karahi?', 'Nahi ji, isme nahi hota.'],
    ['nuts ka masla hai, kebab?', 'Is mein sirf qeema aur masala dalta hai.'],
  ])('“%s” gets the owner’s allergy answer, not “%s”', (text, modelText) => {
    const result = turn(company, text, answer, says(modelText));
    expect(result.reply).toBe(allergyFaq.answer);
    expect(result.traces).toContain('allergy_question_guarded');
    // Without an approved answer: the fixed notice in the customer's language, and a person.
    const handed = turn(noAnswer, text, answer, says(modelText));
    expect(handed.reply).not.toContain(modelText);
    expect(handed.reply).toContain('+92 300 000 0001');
    expect(handed.conversation.mode).toBe('human');
  });

  it('leaves ordinary answers about dishes named after an allergen alone', () => {
    const fish = turn(
      noAnswer,
      'fish hai kya?',
      answer,
      says('Ji haan, Fish Tikka available hai.'),
    );
    expect(fish.reply).toBe('Ji haan, Fish Tikka available hai.');
    // The same words to a message that names no allergen are an ordinary answer.
    const dineIn = turn(
      noAnswer,
      'kya yahan baith kar kha sakte hain?',
      answer,
      says('Ji haan, aap yahan baith kar kha sakte hain.'),
    );
    expect(dineIn.reply).toBe('Ji haan, aap yahan baith kar kha sakte hain.');
    expect(dineIn.conversation.mode).toBe('bot');
    const order = turn(
      noAnswer,
      '1 fish tikka aur 2 naan',
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      { text: 'Pickup or delivery?', askFor: 'fulfillment' },
    );
    expect(order.reply).toContain('Pickup or delivery?');
    expect(order.conversation.mode).toBe('bot');
  });

  it('keeps the owner’s wording only when the AI quotes it whole', () => {
    const owner: Company = {
      ...noAnswer,
      faqs: [...noAnswer.faqs, { question: 'nuts', answer: 'No dish is guaranteed nut-free.' }],
    };
    const fragment = turn(
      owner,
      'tell me about your curries',
      answer,
      says('Guaranteed nut-free!'),
    );
    expect(fragment.reply).not.toContain('nut-free');
    expect(fragment.decision?.corrections).toContain('allergy_assurance_ignored');
  });
});
