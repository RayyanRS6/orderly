import { describe, expect, it } from 'vitest';
import { closedText, createConversation, processTurn } from '../src/domain/engine';
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
const at = (hours: number) => new Date(Date.parse(now) + hours * 3600000).toISOString();
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
// Open 12:00–23:00 Karachi time: 02:30 on Thursday (8 hours after `now`) is closed.
const hours = (days = [0, 1, 2, 3, 4, 5, 6]): Company => ({
  ...company,
  openingHours: { start: '12:00', end: '23:00', days },
});
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
const fresh = () => createConversation(company.id, '923000000096', 'demo', now);
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
    { messageId: `fx1-closed-${++message}`, text, now: when, ...extra },
    actions,
    response,
  );
}

describe('G7.5: a closed restaurant says so in its first reply, with when it opens', () => {
  const night = at(8); // Thursday 02:30 in Karachi
  const closedLine =
    'We are currently closed. Ordering hours are 12:00–23:00. We open again today at 12:00.';
  const notice = `${closedLine} You can look at the menu now and order when we open.`;

  it('tells the customer in its first reply, once, and takes no order', () => {
    const first = turn(hours(), fresh(), 'menu', night);
    expect(first.reply.startsWith(`${notice}\n\n`)).toBe(true);
    expect(first.traces).toContain('closed_notice');
    // Another question is answered without saying it again.
    const second = turn(hours(), first.conversation, 'menu', night);
    expect(second.reply).not.toContain('We are currently closed.');
    // The next night is a new closed period.
    const nextNight = turn(hours(), second.conversation, 'menu', at(32));
    expect(nextNight.reply.startsWith('We are currently closed.')).toBe(true);
    // An order is refused, however often it is asked, and the AI's own wording is not sent.
    const order = turn(
      hours(),
      second.conversation,
      '2 chicken biryani',
      night,
      [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
      { text: 'All set. Anything else?', askFor: 'anything_else' },
    );
    expect(order.reply).toBe(
      `${closedLine} We can’t take orders now, so this has not been ordered. Please message us again when we are open.`,
    );
    expect(order.conversation.cart.items).toHaveLength(0);
    expect(order.traces).toContain('closed_refused');
    expect(order.traces).not.toContain('add_item');
  });

  it('says when it opens next on a closed day, in the customer’s language', () => {
    // Thursday closed: opens on Friday; open only on Mondays: on Monday.
    expect(closedText(hours([0, 1, 2, 3, 5, 6]), 'en', night)).toBe(
      'We are currently closed. Ordering hours are 12:00–23:00. We open again tomorrow at 12:00.',
    );
    expect(closedText(hours([1]), 'en', night)).toBe(
      'We are currently closed. Ordering hours are 12:00–23:00. We open again on Monday at 12:00.',
    );
    expect(closedText(hours(), 'ur', night)).toBe(
      'ہم اس وقت بند ہیں۔ آرڈر کا وقت 12:00–23:00 ہے۔ ہم آج 12:00 بجے دوبارہ کھلیں گے۔',
    );
    expect(closedText(hours([0, 1, 2, 3, 5, 6]), 'roman-ur', night)).toBe(
      'Hum is waqt band hain. Order ka waqt 12:00–23:00 hai. Hum kal 12:00 baje dobara khulenge.',
    );
    expect(closedText(hours([1]), 'ur', night)).toContain('ہم پیر کو 12:00 بجے دوبارہ کھلیں گے۔');
    // Without the time, or with no opening day, only the hours.
    expect(closedText(hours(), 'en')).toBe(
      'We are currently closed. Ordering hours are 12:00–23:00.',
    );
    expect(closedText(hours([]), 'en', night)).toBe(
      'We are currently closed. Ordering hours are 12:00–23:00.',
    );
    const urdu = turn(inLanguage(hours(), 'ur'), fresh(), 'مینو', night);
    expect(urdu.reply.startsWith('ہم اس وقت بند ہیں۔')).toBe(true);
    expect(urdu.reply).toContain('آپ ابھی مینو دیکھ سکتے ہیں');
  });

  it('adds nothing while open, and says it once in a refusal', () => {
    const open = turn(hours(), fresh(), 'menu', now);
    expect(open.reply).not.toContain('closed');
    const refused = turn(hours(), fresh(), '2 chicken biryani', night);
    expect(refused.reply.split('We are currently closed.')).toHaveLength(2);
  });

  it('tells a customer handed to staff when the team will reply', () => {
    const staff = turn(hours(), fresh(), 'staff', night);
    expect(staff.conversation.mode).toBe('human');
    expect(staff.reply).toContain(`${closedLine} Our team will reply here once we are open.`);
    expect(turn(hours(), fresh(), 'staff', now).reply).not.toContain('closed');
  });
});
