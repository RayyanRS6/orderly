// Final review, fx-6 (customer-wording-7/8, conversation-6/8/9): the closed notice follows the
// owner's greeting and promises nothing about a cancelled cart, a late message is worded for
// when it is answered, and "restaurant kahan hai?" is not a question about the order.
import { describe, expect, it } from 'vitest';
import { asksOrderStatus, closedText } from '../src/domain/engine';
import { at, company, fresh, hours, latest, now, placed, turn, withBot } from './helpers/fx6-turns';

describe('the closed notice and late messages', () => {
  const night = at(8); // Thursday 02:30 in Karachi
  const greeting = 'Assalam o Alaikum! Dastarkhwan mein khush aamdeed. Aaj kya order karenge?';

  it('follows the owner’s greeting instead of coming before it', () => {
    const owner = withBot(hours, { greeting });
    const result = turn(owner, fresh(), 'salam', { now: night });
    expect(result.reply).toBe(
      `${greeting}\n\n${closedText(owner, 'roman-ur', night)} Aap phir bhi menu dekh kar items add kar sakte hain, cart save rahega.`,
    );
    expect(result.traces).toContain('closed_notice');
  });

  it('does not promise to save a cart the customer just cancelled', () => {
    const c = turn(hours, fresh(), '2 chicken biryani', { now: at(1) }).conversation;
    const cancelled = turn(hours, c, 'cancel', { now: night });
    expect(cancelled.reply).toContain('We are currently closed.');
    expect(cancelled.reply).toContain('Your cart has been cancelled.');
    expect(cancelled.reply).not.toContain('your cart will be saved');
  });

  it('words opening hours and status age for when a late message is answered', () => {
    // Sent at 11:55 (closed), answered at 12:20 (open).
    const sent = at(-6.5 - 1 / 12);
    const answered = at(-6.5 + 1 / 3);
    const late = turn(hours, fresh(), 'menu', { now: sent, receivedAt: answered, late: true });
    expect(late.reply).not.toContain('We are currently closed.');
    const { conversation, order } = placed();
    const status = turn(company, conversation, 'kitni der?', {
      now: at(-1),
      receivedAt: now,
      late: true,
      latestOrder: latest(order, 'accepted', at(-1)),
    });
    expect(status.reply).toContain('Last update: about an hour ago.');
  });
});

describe('“restaurant kahan hai?” is not about the order', () => {
  const order = { status: 'accepted' as const, updatedAt: at(-1 / 6) };
  it.each([
    'aap ka restaurant kahan hai?',
    'shop kahan hai? pickup ke liye aana hai',
    'ریسٹورنٹ کہاں ہے؟',
    'branch kahan hai',
    'location kahan hai?',
    'how long does pickup take?',
  ])('“%s”', (text) => {
    expect(asksOrderStatus(text, order, now)).toBe(false);
  });

  it.each(['kahan hai?', 'order kahan hai?', 'khana kahan reh gaya', 'how long will it take?'])(
    'still answers “%s” with the order',
    (text) => {
      expect(asksOrderStatus(text, order, now)).toBe(true);
    },
  );
});
