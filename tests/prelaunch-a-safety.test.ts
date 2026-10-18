import { describe, expect, it } from 'vitest';
import {
  asksAboutAllergens,
  assuresSafety,
  createConversation,
  processTurn,
} from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, ModelResponse } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const allergyFaq = company.faqs.find((f) => f.question === 'allergy')!;
// The same restaurant before the owner wrote an approved allergy answer.
const noAnswer: Company = { ...company, faqs: company.faqs.filter((f) => f !== allergyFaq) };
const fresh = () => createConversation(company.id, '923000000066', 'demo', now);
let message = 0;
function turn(
  restaurant: Company,
  text: string,
  actions: BotAction[] | undefined,
  response?: ModelResponse,
  c: Conversation = fresh(),
  extra: { menuLink?: string } = {},
) {
  return processTurn(
    restaurant,
    products,
    c,
    { messageId: `safety-${++message}`, text, now, ...extra },
    actions,
    response,
  );
}
const answer: BotAction[] = [{ type: 'answer', text: '' }];
const says = (text: string, extra: Partial<ModelResponse> = {}): ModelResponse => ({
  text,
  askFor: 'none',
  ...extra,
});
function reviewed() {
  let c = turn(company, '2 chicken biryani', undefined).conversation;
  c = processTurn(company, products, c, {
    messageId: `safety-${++message}`,
    text: '',
    now,
    action: { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
  }).conversation;
  return c;
}
const notice = {
  en: 'We can’t confirm allergens or ingredients in this chat. A staff member will reply here to help you. You can also call us on +92 300 000 0001.',
  'roman-ur':
    'Hum is chat mein allergy ya ingredients confirm nahi kar sakte. Staff ka koi member yahin aap ko jawab dega. Aap hamein +92 300 000 0001 par call bhi kar sakte hain.',
  ur: 'ہم اس چیٹ میں الرجی یا اجزا کی تصدیق نہیں کر سکتے۔ عملے کا ایک رکن یہیں آپ کو جواب دے گا۔ آپ ہمیں +92 300 000 0001 پر کال بھی کر سکتے ہیں۔',
};

describe('F09: allergy questions never get AI wording', () => {
  it.each([
    [
      'is the biryani nut free?',
      'Yes, our Chicken Biryani is completely nut-free and safe for nut allergies.',
      'en',
    ],
    ['does the naan have gluten?', 'No gluten at all in our naan!', 'en'],
    ['any peanuts in the karahi?', 'No nuts at all, totally safe.', 'en'],
    ['mujhe batayein, kya biryani mein peanuts hain?', 'Nahi, bilkul nahi. Safe hai.', 'roman-ur'],
    ['kya biryani mein peanuts hain?', 'Nahi, bilkul nahi. Safe hai.', 'en'],
    ['کیا بریانی میں مونگ پھلی ہے؟', 'نہیں، بالکل محفوظ ہے۔', 'ur'],
    ['I have a nut allergy, is the korma ok?', 'Yes the korma is safe for you.', 'en'],
  ] as const)('“%s” gets the fixed notice and a person', (text, modelText, lang) => {
    const result = turn(noAnswer, text, answer, says(modelText, { groundingIds: [biryani.id] }));
    expect(result.reply).toBe(notice[lang]);
    expect(result.conversation.mode).toBe('human');
    expect(result.traces).toContain('handoff');
    expect(result.decision?.modelText).toBe('protected');
    expect(result.decision?.corrections).toContain('allergy_question_guarded');
  });

  it('sends the owner’s approved allergy answer word for word, whatever the AI wrote', () => {
    for (const text of [
      'I have a nut allergy, is biryani ok?',
      'any allergies info?',
      'nut free?',
    ]) {
      const result = turn(
        company,
        text,
        [{ type: 'answer', text: allergyFaq.answer }],
        says('Yes, it is nut-free and safe.', { groundingIds: ['faq:2'] }),
      );
      expect(result.reply, text).toBe(allergyFaq.answer);
      expect(result.conversation.mode).toBe('bot');
      expect(result.decision?.parts).toEqual(['approved_answer']);
      expect(result.decision?.modelText).toBe('protected');
    }
  });

  it('keeps the cart line on an order turn and answers the question safely', () => {
    const result = turn(
      company,
      'add 1 biryani, is it nut free?',
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      says('It is nut-free! Pickup or delivery?', { askFor: 'fulfillment' }),
    );
    expect(result.conversation.cart.items).toEqual([
      expect.objectContaining({ productId: biryani.id, quantity: 1 }),
    ]);
    expect(result.reply).toContain('Added 1 × Chicken Biryani');
    expect(result.reply).toContain(allergyFaq.answer);
    expect(result.reply).not.toContain('nut-free!');
    const handed = turn(
      noAnswer,
      'add 1 biryani, is it nut free?',
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      says('It is nut-free!'),
    );
    expect(handed.conversation.cart.items).toHaveLength(1);
    expect(handed.reply).toContain('Added 1 × Chicken Biryani');
    expect(handed.reply.endsWith(notice.en)).toBe(true);
    expect(handed.conversation.mode).toBe('human');
  });

  it('is not replaced by an owner greeting, handoff message, other rule or menu link', () => {
    const rule = {
      id: 'wait',
      enabled: true,
      when: 'Customer asks to wait',
      action: 'reply' as const,
      responseMode: 'exact' as const,
      response: 'Take your time.',
    };
    const owner: Company = {
      ...noAnswer,
      bot: {
        draft: defaultBot,
        revision: 1,
        history: [],
        published: {
          version: 1,
          config: {
            ...defaultBot,
            greeting: 'Welcome!',
            handoffMessage: 'Our team will reply soon.',
            behaviorRules: [rule],
          },
          publishedAt: now,
          publishedBy: 'test',
        },
      },
    };
    const ruled = turn(
      owner,
      'does it contain nuts?',
      answer,
      says('No.', { matchedRuleId: 'wait' }),
    );
    expect(ruled.reply).toBe(notice.en);
    const handoff = turn(owner, 'is it nut free?', [{ type: 'handoff' }]);
    expect(handoff.reply).toBe(notice.en);
    // The engine's menu keeps its own link once; the notice follows it.
    const link = 'https://orderly.example/m/x';
    const menu = turn(
      owner,
      'menu, any nuts in the karahi?',
      [{ type: 'menu' }],
      says('Here:'),
      fresh(),
      {
        menuLink: link,
      },
    );
    expect(menu.reply.split(link)).toHaveLength(2);
    expect(menu.reply).not.toContain('Here:');
    expect(menu.reply.endsWith(notice.en)).toBe(true);
  });

  it('guards a follow-up question straight after an allergy question', () => {
    const first = turn(company, 'I am allergic to peanuts', answer, says(''));
    const followUp = turn(
      company,
      'and the karahi?',
      answer,
      says('Nahi, bilkul nahi.'),
      first.conversation,
    );
    expect(followUp.reply).toBe(allergyFaq.answer);
    expect(followUp.traces).toContain('allergy_question_guarded');
    const safe = turn(company, "so it's safe?", answer, says('Yes!'), first.conversation);
    expect(safe.reply).toBe(allergyFaq.answer);
    // Another topic, or the menu, is answered as usual.
    const delivery = turn(
      company,
      'do you deliver to DHA?',
      answer,
      says('Yes, we deliver to DHA.'),
      first.conversation,
    );
    expect(delivery.reply).toBe('Yes, we deliver to DHA.');
    const link = 'https://orderly.example/m/x';
    const menu = turn(company, 'menu?', [{ type: 'menu' }], says(''), first.conversation, {
      menuLink: link,
    });
    expect(menu.traces).not.toContain('allergy_question_guarded');
  });

  it.each([
    '2 doodh patti',
    'anda paratha',
    '1 jheenga karahi',
    'peanut shake',
    'til naan',
    'dahi bhallay',
    'egg fried rice',
    'Dairy Milk shake',
    'peanut butter shake please',
    'do you have peanut shake?',
    'will I have egg paratha with that?',
    'anda paratha hai?',
    'menu mein anda paratha hai?',
    'biryani without egg please',
    'any egg fried rice in stock?',
    '1 fish tikka aur 2 naan',
  ])('leaves an ordinary order alone: %s', (text) => {
    expect(asksAboutAllergens(text)).toBe(false);
    const result = turn(
      company,
      text,
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      says('Added! Anything else?', { askFor: 'anything_else' }),
    );
    expect(result.conversation.mode).toBe('bot');
    expect(result.reply).toContain('Added! Anything else?');
    expect(result.traces).not.toContain('allergy_question_guarded');
  });

  it.each([
    'is the biryani gluten-free?',
    'does it contain nuts?',
    'is there any dairy in the korma?',
    'is it cooked in peanut oil?',
    'mujhe allergy hai',
    'lactose intolerant hun, raita le sakta hun?',
    'safe for celiac?',
    'is mein anda hai?',
    'peanuts hain kya',
    'مجھے الرجی ہے',
    'کیا اس میں انڈا ہے؟',
  ])('recognises an allergy question: %s', (text) => {
    expect(asksAboutAllergens(text)).toBe(true);
  });
});

describe('F09: AI reassurances about allergens are dropped unless they are the owner’s words', () => {
  it.each([
    'Our korma is nut-free and delicious!',
    'All our dishes are allergy safe.',
    'There are no nuts in the biryani.',
    'It doesn’t contain gluten.',
    'Is mein nuts nahi hain.',
    'Bilkul safe hai.',
  ])('drops “%s” on a question that did not mention allergies', (text) => {
    expect(assuresSafety(text)).toBe(true);
    const result = turn(noAnswer, 'tell me about your curries', answer, says(text));
    expect(result.reply).not.toContain(text);
    expect(result.decision?.modelText).toBe('unsafe');
    expect(result.decision?.corrections).toContain('allergy_assurance_ignored');
  });

  it('drops an AI menu introduction that promises allergen-free dishes', () => {
    const result = turn(
      company,
      'show menu',
      [{ type: 'menu' }],
      says('Here are our nut-free dishes:'),
    );
    expect(result.reply).not.toContain('nut-free');
    expect(result.reply).toContain('Chicken Biryani');
  });

  it('keeps the owner’s own approved wording when the AI quotes it exactly', () => {
    const owner: Company = {
      ...noAnswer,
      faqs: [...noAnswer.faqs, { question: 'curries', answer: 'All our curries are nut-free.' }],
    };
    const result = turn(
      owner,
      'tell me about your curries',
      answer,
      says('All our curries are nut-free.'),
    );
    expect(result.reply).toBe('All our curries are nut-free.');
    expect(result.decision?.modelText).toBe('used');
  });

  it.each([
    'Yes, we have doodh patti and anda paratha.',
    'Sorry, no fish today.',
    'We don’t have doodh patti right now.',
    'Our peanut shake is popular!',
  ])('keeps ordinary menu wording: %s', (text) => {
    expect(assuresSafety(text)).toBe(false);
  });
});

describe('F07: AI wording never announces an outcome or a price', () => {
  it.each([
    'Shukriya! Aap ka order confirm ho gaya hai, 30 minute mein ready hoga.',
    'آپ کا آرڈر کنفرم ہو گیا ہے۔ کل ۴۵۰ روپے',
    'Great, your order is on its way!',
    'Your order is being prepared.',
    'Biryani 450/- ki hai',
    'Total comes to 1,200/-',
    'That is 500 PKR.',
    'Chicken Biryani is 300 rupees.',
    'Biryani ۴۵۰ روپے کی ہے۔',
    'Order received, thanks!',
    'Payment received, thanks!',
    'Aap ka order book kar diya hai.',
    'Restaurant ne aap ka order accept kar liya hai.',
    'آپ کا آرڈر منظور ہو گیا ہے۔',
  ])('drops “%s” after a review, with no order', (text) => {
    const result = turn(company, 'ok', answer, says(text), reviewed());
    expect(result.order).toBeUndefined();
    expect(result.reply).not.toContain(text);
    expect(result.decision?.modelText).toBe('unsafe');
    expect(result.decision?.corrections).toContain('unsafe_model_response_ignored');
  });

  it('drops a false claim on a details turn and asks the next question instead', () => {
    let c = turn(company, '2 chicken biryani', undefined).conversation;
    c = processTurn(company, products, c, {
      messageId: `safety-${++message}`,
      text: '',
      now,
      action: { type: 'set_details', fulfillment: 'pickup' },
    }).conversation;
    const result = turn(
      company,
      'Ali naam likh lein',
      [{ type: 'set_details', customerName: 'Ali' }],
      says('Shukriya Ali, aap ka order place ho gaya hai'),
      c,
    );
    expect(result.reply).not.toContain('place ho gaya');
    expect(result.traces).toContain('response_fallback');
    expect(result.decision?.modelText).toBe('unsafe');
    expect(result.order).toBeUndefined();
  });

  it.each([
    'Ji, aap ka naam save ho gaya hai. Pickup ya delivery?',
    'Hum kal 12 baje khulenge.',
    'ہم کل ۱۲ بجے کھلیں گے۔',
    'Aap ka message mil gaya.',
    'Order confirm karne ke liye confirm likhein.',
    'Kya aap order confirm karna chahenge?',
    'Aap ka order abhi confirm nahi hua.',
    'Delivery mein 30-40 minute lagte hain.',
    'Aap order confirm kar dijiye.',
  ])('keeps ordinary wording: %s', (text) => {
    const result = turn(company, 'hello?', answer, says(text));
    expect(result.reply).toBe(text);
    expect(result.decision?.modelText).toBe('used');
    expect(result.conversation.mode).toBe('bot');
  });

  it('lets the AI say a submitted order was received, but not before submission', () => {
    const submitted = processTurn(company, products, reviewed(), {
      messageId: `safety-${++message}`,
      text: 'confirm',
      now,
    }).conversation;
    const text = 'Shukriya! Order receive ho gaya, restaurant jald accept karega.';
    const thanks = turn(company, 'thanks', answer, says(text), submitted);
    expect(thanks.reply).toBe(text);
    expect(thanks.conversation.mode).toBe('bot');
    expect(turn(company, 'thanks', answer, says(text), reviewed()).reply).not.toBe(text);
  });
});
