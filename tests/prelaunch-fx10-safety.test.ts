// Final review, fx-10 (conversation-2, conversation-3, customer-wording-3 and the sweep's P1):
// asking whether a dish has egg, milk or fish in it is an allergy question also without an
// article ("is there egg in naan"), as "do you put egg in the naan?" or "does it come with egg?";
// and an AI that vouches for a dish to a customer who says a food upsets them is guarded however
// they word it, also when that food is a dish on the menu. Orders and menu questions stay with
// the bot.
import { describe, expect, it } from 'vitest';
import {
  asksAboutAllergens,
  assuresSafety,
  createConversation,
  processTurn,
} from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, ModelResponse, Product } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const allergyFaq = company.faqs.find((f) => f.question === 'allergy')!;
const noAnswer: Company = { ...company, faqs: company.faqs.filter((f) => f !== allergyFaq) };
let id = 0;
const dish = (name: string, aliases: string[]): Product => ({
  ...biryani,
  id: `55555555-5555-4555-a555-${String(++id).padStart(12, '0')}`,
  name,
  aliases,
  variants: [],
  modifiers: [],
});
// Dishes named after a food people avoid, as Pakistani menus have them.
const named = [
  ...products,
  dish('Fish Tikka', ['fish', 'fish tikka']),
  dish('Anda Paratha', ['anda paratha']),
  dish('Doodh Patti', ['doodh patti', 'chai']),
  dish('Badam Shake', ['badam shake']),
];
let message = 0;
function turn(
  restaurant: Company,
  text: string,
  actions: BotAction[],
  response: ModelResponse,
  catalog = products,
) {
  return processTurn(
    restaurant,
    catalog,
    createConversation(company.id, '923000000172', 'demo', now),
    { messageId: `fx10-safety-${++message}`, text, now },
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
function expectGuarded(text: string, modelText: string, catalog = products) {
  const approved = turn(company, text, answer, says(modelText), catalog);
  expect(approved.reply, text).toBe(allergyFaq.answer);
  expect(approved.traces, text).toContain('allergy_question_guarded');
  const handed = turn(noAnswer, text, answer, says(modelText), catalog);
  expect(handed.reply, text).not.toContain(modelText);
  expect(handed.reply, text).toContain('+92 300 000 0001');
  expect(handed.conversation.mode, text).toBe('human');
  expect(handed.traces, text).toContain('allergy_question_guarded');
}

describe('fx-10: a food allergen in a dish is asked about with or without an article', () => {
  it.each([
    'is there egg in naan',
    'is there egg in naan?',
    'any egg in naan',
    'is there milk in kheer',
    'any milk in kheer?',
    'is there fish in biryani',
    'is there egg inside the naan',
    'is there egg or milk in the naan',
    'egg in naan?',
    'is there egg in the breakfast paratha',
    'naan mein anda to nahi',
    'isme anda to nahi',
  ])('recognises “%s”', (text) => {
    expect(asksAboutAllergens(text)).toBe(true);
  });

  it.each([
    'is there fish in the lunch menu',
    'is there fish in this week’s menu',
    "is there fish in this week's menu",
    'any fish in the specials',
    'is there fish in the deals',
    'is there fish in the menu today',
    'is there fish in stock',
    'any fish in the evening',
    'is there any fish in your restaurant',
    'is there fish in our winter menu',
    'any fish in lunch?',
    'is there fish in karachi branch?',
    'is there any fish in the dinner deal',
    'fish in stock?',
    'prawns in garlic sauce?',
  ])('still treats “%s” as a menu question', (text) => {
    expect(asksAboutAllergens(text)).toBe(false);
  });

  it.each([
    ['is there egg in naan?', 'No, the naan only has flour, butter and yeast.'],
    ['is there milk in kheer', 'Yes, kheer is made with milk.'],
    ['is there fish in biryani', 'No, our biryani is just chicken, rice and spices.'],
    ['any egg in naan', 'No, we don’t put egg in our naan.'],
    ['naan mein anda to nahi', 'Nahi ji, isme nahi hota.'],
  ])('“%s” gets the owner’s answer or a person, never “%s”', (text, modelText) => {
    expectGuarded(text, modelText);
  });
});

describe('fx-10: “do you put egg in it?” is a question, “can you add egg in it?” an order', () => {
  it.each([
    'do you put egg in the naan?',
    'Do you put egg in the naan?',
    'do you add eggs in the cake?',
    'does the burger come with egg in it?',
    'did you put egg in my paratha?',
    'do you guys put egg in the naan?',
    'do you put milk in the tea?',
    'do you add milk in the kheer?',
    'does the naan come with egg in it?',
    'do you use eggs in the cake?',
  ])('recognises “%s”', (text) => {
    expect(asksAboutAllergens(text)).toBe(true);
  });

  it.each([
    ['do you put egg in the naan?', 'No, we don’t put egg in our naan.'],
    ['do you add eggs in the naan?', 'No, we don’t add eggs to our naan.'],
    ['does the naan come with egg in it?', 'No, our naan comes without egg.'],
    ['did you put egg in the naan?', 'No, the naan is just flour, yogurt and butter.'],
    ['do you add milk in the kheer?', 'Our kheer only has rice, sugar and cardamom.'],
  ])('“%s” gets the owner’s answer or a person, never “%s”', (text, modelText) => {
    expectGuarded(text, modelText);
  });

  it.each([
    'can you add egg in it?',
    'can you add any egg in it',
    'can I get egg in my paratha?',
    'I will add egg paratha too',
    'paratha mein anda dala hua chahiye',
    'burger mein egg dala hua ho',
    'cook me fish?',
    'find me fish?',
    'fry me fish?',
    'do you have eggs?',
  ])('“%s” stays an order or a menu question', (text) => {
    expect(asksAboutAllergens(text)).toBe(false);
    const result = turn(noAnswer, text, addBiryani, says('Added! Anything else?', 'anything_else'));
    expect(result.conversation.mode).toBe('bot');
    expect(result.reply).toContain('Added! Anything else?');
    expect(result.traces).not.toContain('allergy_question_guarded');
  });

  it('drops the AI’s own “we don’t put egg in it” whatever was asked', () => {
    for (const text of [
      'No, we don’t put egg in our naan.',
      'No, we don’t add eggs to our naan.',
      'We do not put any milk in it.',
      'No, our naan comes without egg.',
      'We make it without eggs.',
      'Cooked without milk.',
    ])
      expect(assuresSafety(text), text).toBe(true);
    for (const text of [
      'Sorry, no fish today.',
      'We don’t have doodh patti right now.',
      'Biryani without raita, noted.',
    ])
      expect(assuresSafety(text), text).toBe(false);
  });
});

describe('fx-10: vouching for a dish to someone a food upsets is guarded however they say it', () => {
  it.each([
    ['mujhe doodh suit nahi karta, kheer theek hai?', 'Ji haan, aap kha sakte hain.'],
    ['anday se mujhe dikkat hoti hai, paratha le lun?', 'Bilkul, aap kha sakte hain.'],
    ['machli hazam nahi hoti, biryani theek rahegi?', 'Ji, aap biryani kha sakte hain.'],
    ['egg se takleef hoti hai, naan le sakta hun?', 'Ji, aap naan kha sakte hain.'],
    ['I cant have milk, is the kheer fine?', 'Yes, it is totally fine for you, shall I add one?'],
    ['mujhe anda nahi khana, paratha theek hai?', 'Ji, bilkul okay for you, add kar doon?'],
    ['machli mujhe suit nahi karti, karahi theek hai?', 'Ji haan, aap kha sakte hain.'],
    ['anda mujhe suit nahi karta, paratha theek hai?', 'Ji haan, aap kha sakte hain.'],
    ['I react badly to eggs, is the korma fine?', 'Yes, totally fine for you.'],
    ['my son does not eat eggs, is the naan okay?', 'The naan only has flour, butter and yeast.'],
    ['My son doesn’t eat eggs, is the naan okay?', 'Yes, it is fine for you.'],
    ["My son doesn't eat eggs, is the naan okay?", 'Yes, it is fine for you.'],
    ['he won’t eat egg, is the naan okay?', 'Yes, it is fine for you.'],
    ['eggs make me sick, is the naan okay?', 'Yes, totally fine for you.'],
    ['milk upsets my stomach, is the kheer ok?', 'Yes, totally fine for you.'],
    ['doodh hazam nahi hota, kheer theek hai?', 'Ji haan, aap kha sakte hain.'],
    ['مجھے دودھ سوٹ نہیں کرتا، کھیر ٹھیک ہے؟', 'Ji haan, aap kha sakte hain.'],
    ['انڈا ہضم نہیں ہوتا، نان ٹھیک ہے؟', 'Ji haan, aap kha sakte hain.'],
    ['مچھلی سے تکلیف ہوتی ہے، بریانی ٹھیک ہے؟', 'Ji haan, aap kha sakte hain.'],
    ['mujhe bina anday ke chahiye, naan theek hai?', 'Ji haan, aap kha sakte hain.'],
  ])('“%s” never gets “%s”', (text, modelText) => {
    expectGuarded(text, modelText);
  });

  it.each([
    ['I cannot eat fish, is the karahi fine?', 'Yes, totally fine for you.'],
    ['I can’t have fish, is the karahi fine?', 'Yes, totally fine for you.'],
    ['mujhe anda nahi khana, naan theek hai?', 'Ji haan, aap kha sakte hain.'],
    ['doodh suit nahi karta, chai ki jagah lassi theek hai?', 'Ji, aap kha sakte hain.'],
  ])('also when the food is a dish’s name on the menu: “%s”', (text, modelText) => {
    expectGuarded(text, modelText, named);
  });

  it.each([
    ['2 chicken biryani, 2 anda paratha aur doodh patti', 'Is that okay for you?'],
    ['2 chicken biryani aur 1 fish', 'Would pickup be fine for you?'],
    ['2 badam shakes', 'Ji, aap kha sakte hain.'],
    ['2 anda parathay, pyaz ke bina', 'Ji, pyaz nahi dala jayega.'],
    ['1 dudh patti without sugar', 'Ji, cheeni nahi dali jayegi.'],
    ['2 chicken biryani aur ek anda paratha', 'Done! Is that okay for you, or anything else?'],
  ])('leaves the order “%s” with the bot', (text, modelText) => {
    for (const restaurant of [company, noAnswer]) {
      const result = turn(restaurant, text, addBiryani, says(modelText, 'anything_else'), named);
      expect(result.conversation.mode, text).toBe('bot');
      expect(result.reply, text).toContain(modelText);
      expect(result.traces, text).not.toContain('allergy_question_guarded');
    }
  });
});
