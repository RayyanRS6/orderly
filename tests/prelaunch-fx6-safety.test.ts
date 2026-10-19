// Final review, fx-6 (conversation-2, conversation-3, customer-wording-3): asking whether a dish
// contains egg, milk, fish or shellfish is guarded with or without "?", while ordering a dish
// named after one, or asking for an ingredient to be added, is an ordinary order.
import { describe, expect, it } from 'vitest';
import {
  asksAboutAllergens,
  assuresSafety,
  createConversation,
  processTurn,
} from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, ModelResponse } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const naan = products.find((p) => p.name === 'Butter Naan')!;
const allergyFaq = company.faqs.find((f) => f.question === 'allergy')!;
const noAnswer: Company = { ...company, faqs: company.faqs.filter((f) => f !== allergyFaq) };
const fresh = () => createConversation(company.id, '923000000162', 'demo', now);
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
    { messageId: `fx6-safety-${++message}`, text, now },
    actions,
    response,
  );
}
const answer: BotAction[] = [{ type: 'answer', text: '' }];
const says = (text: string, askFor: ModelResponse['askFor'] = 'none'): ModelResponse => ({
  text,
  askFor,
});
const addBiryani: BotAction[] = [{ type: 'add_item', productId: biryani.id, quantity: 2 }];

describe('fx-6: “is there egg in it” is an allergy question without a “?”', () => {
  it.each([
    'is there egg in it',
    'are there eggs in the cake',
    'any egg in it',
    'is there milk in the kheer',
    'is there fish in the biryani',
    'any prawns in the fried rice',
    'is there any milk in it',
    'is there egg in the naan',
    'is there egg in this',
    'any egg in the naan',
    'is there milk in the gulab jamun',
  ])('recognises “%s”', (text) => {
    expect(asksAboutAllergens(text)).toBe(true);
  });

  it.each([
    'is there fish in stock',
    'any fish in stock',
    'any fish in the evening',
    'is there any fish in your restaurant',
    'is there fish in our winter menu',
    'fish hai kya?',
    'do you have eggs?',
    'is there any fish?',
  ])('still treats “%s” as a menu question', (text) => {
    expect(asksAboutAllergens(text)).toBe(false);
  });

  it.each([
    ['is there milk in the gulab jamun', 'No, our gulab jamun has no milk in it.'],
    ['is there egg in the naan', 'No, our butter naan is made without eggs.'],
    ['any egg in the naan', 'The naan is eggless, so you can enjoy it.'],
    ['is there fish in the biryani', 'No, there is no fish in our biryani.'],
  ])('“%s” gets the owner’s answer or a person, never “%s”', (text, modelText) => {
    const approved = turn(company, text, answer, says(modelText));
    expect(approved.reply).toBe(allergyFaq.answer);
    expect(approved.traces).toContain('allergy_question_guarded');
    const handed = turn(noAnswer, text, answer, says(modelText));
    expect(handed.reply).not.toContain(modelText);
    expect(handed.reply).toContain('+92 300 000 0001');
    expect(handed.conversation.mode).toBe('human');
  });

  it('drops these reassurances whatever was asked, but not menu wording', () => {
    for (const text of [
      'No, our gulab jamun has no milk in it.',
      'No, our butter naan is made without eggs.',
      'The naan is eggless, so you can enjoy it.',
      'No, there is no fish in the biryani.',
    ])
      expect(assuresSafety(text), text).toBe(true);
    for (const text of ['Sorry, no fish today.', 'Sorry, no fish in stock today.'])
      expect(assuresSafety(text), text).toBe(false);
  });
});

describe('fx-6: an order or a request is not an allergy question', () => {
  it.each([
    'can I get egg in my paratha?',
    'extra egg in my burger?',
    'add an egg in the burger?',
    'can you add egg in it?',
    'add prawns in the fried rice?',
    'can i get milk in the tea?',
    'burger me egg',
    'paratha mein anda',
    'anda dala hua paratha chahiye',
    'suggest me fish?',
    'recommend me fish?',
    'extra cheese',
    'anda paratha with extra egg',
    'can you add any egg in it',
  ])('“%s” is an order, answered as usual', (text) => {
    expect(asksAboutAllergens(text)).toBe(false);
    const result = turn(noAnswer, text, addBiryani, says('Added! Anything else?', 'anything_else'));
    expect(result.conversation.mode).toBe('bot');
    expect(result.reply).toContain('Added! Anything else?');
    expect(result.traces).not.toContain('allergy_question_guarded');
  });

  it.each([
    ['fish hai?', 'Maaf kijiye, fish abhi stock mein nahi hai.'],
    ['is the fish fresh?', 'Yes, we only use fresh fish.'],
    ['recommend me fish?', 'Our Chicken Tikka is popular, you can have it with naan.'],
  ])('answers “%s” as the AI wrote it', (text, modelText) => {
    const result = turn(noAnswer, text, answer, says(modelText));
    expect(result.reply).toBe(modelText);
    expect(result.conversation.mode).toBe('bot');
    expect(result.traces).not.toContain('allergy_question_guarded');
  });

  it.each([
    ['2 chicken biryani aur ek anda paratha', 'Done! Is that okay for you, or anything else?'],
    ['2 chicken biryani, doodh patti bhi', 'Ji, aap ise raita ke saath kha sakte hain.'],
    ['2 chicken biryani aur 1 fish tikka', 'Added! Would pickup be fine for you?'],
    ['2 chicken biryani aur 1 fish', 'Fish tikka abhi stock mein nahi hai, biryani add kar di.'],
  ])('keeps the AI’s next question on “%s”', (text, modelText) => {
    for (const restaurant of [company, noAnswer]) {
      const result = turn(restaurant, text, addBiryani, says(modelText, 'anything_else'));
      expect(result.conversation.mode).toBe('bot');
      expect(result.reply).toContain('Added 2 × Chicken Biryani');
      expect(result.reply).toContain(modelText);
      expect(result.traces).not.toContain('allergy_question_guarded');
    }
  });

  it('still guards an AI that vouches for a dish to someone who must avoid an allergen', () => {
    for (const [text, modelText] of [
      ['mujhe anda nahi khana, paratha theek hai?', 'Ji haan, aap kha sakte hain.'],
      ['I can’t have milk, is the kheer fine?', 'Yes, totally fine for you.'],
      ['mujhe peanuts se masla hai, biryani le lun?', 'Bilkul, aap kha sakte hain.'],
      ['nuts wali cheez nahi khani, karahi theek hai?', 'Yes, totally fine for you.'],
    ] as const) {
      const result = turn(noAnswer, text, answer, says(modelText));
      expect(result.reply, text).not.toContain(modelText);
      expect(result.conversation.mode, text).toBe('human');
      expect(result.traces, text).toContain('allergy_question_guarded');
    }
    // A naan order with an "okay for you?" question back is not vouching.
    const order = turn(
      noAnswer,
      '2 naan',
      [{ type: 'add_item', productId: naan.id, quantity: 2 }],
      says('Is that okay for you?', 'anything_else'),
    );
    expect(order.reply).toContain('Is that okay for you?');
  });
});
