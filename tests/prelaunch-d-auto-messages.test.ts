import { describe, expect, it } from 'vitest';
import { isPhoneAutoMessage, phoneAutoMessagesSchema } from '../src/shared/whatsapp';

// F29: the shared rule for telling a WhatsApp Business app greeting or away message (sent by the
// phone, arriving like a staff reply) from a real staff takeover. Exact text only.
const greeting = 'Welcome to Laziza! 🍛\nOur menu and prices are below.';
const away = 'ہم آج بند ہیں۔ کل صبح 11 بجے بات کریں گے۔';

describe('phone auto-message matching', () => {
  it('recognises the listed greeting and away texts, whatever the spacing', () => {
    expect(isPhoneAutoMessage(greeting, [greeting])).toBe(true);
    expect(
      isPhoneAutoMessage('  Welcome to Laziza! 🍛  Our menu and prices are below. ', [greeting]),
    ).toBe(true);
    expect(isPhoneAutoMessage(away, [greeting, away])).toBe(true);
    // The same Urdu text in decomposed Unicode form (آ as ا plus madda) still matches.
    expect(away.normalize('NFD')).not.toBe(away);
    expect(isPhoneAutoMessage(away.normalize('NFD'), [away])).toBe(true);
  });

  it('treats anything else from the phone as a staff takeover', () => {
    expect(isPhoneAutoMessage('I will help you', [greeting])).toBe(false);
    // A quick reply that starts like the greeting, or a different case, is still staff.
    expect(isPhoneAutoMessage(`${greeting} Your order is ready.`, [greeting])).toBe(false);
    expect(isPhoneAutoMessage(greeting.toUpperCase(), [greeting])).toBe(false);
    expect(isPhoneAutoMessage(greeting, [])).toBe(false);
    expect(isPhoneAutoMessage(greeting, undefined)).toBe(false);
    expect(isPhoneAutoMessage('', [''])).toBe(false);
    expect(isPhoneAutoMessage('   ', ['   '])).toBe(false);
  });

  it('limits a restaurant to five texts of up to 1,000 characters', () => {
    expect(phoneAutoMessagesSchema.safeParse([greeting, away]).success).toBe(true);
    expect(phoneAutoMessagesSchema.safeParse(Array(6).fill('x')).success).toBe(false);
    expect(phoneAutoMessagesSchema.safeParse(['x'.repeat(1001)]).success).toBe(false);
    expect(phoneAutoMessagesSchema.safeParse(['  ']).success).toBe(false);
  });
});
