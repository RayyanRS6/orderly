import { describe, expect, it } from 'vitest';
import {
  disclosureLine,
  isStaffRequest,
  needsDisclosure,
  withDisclosure,
} from '../src/domain/disclosure';
import type { Conversation } from '../src/shared/types';

const now = '2026-09-09T13:30:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60000).toISOString();

describe('F12: every chat session starts with the automated-assistant notice', () => {
  const chat = (messages: Conversation['messages'], botResumedAt?: string) => ({
    messages,
    botResumedAt,
  });
  const line = disclosureLine('Dastarkhwan', 'en');

  it('has fixed wording in each language', () => {
    expect(line).toBe(
      'Dastarkhwan’s automated assistant. Type “staff” anytime to talk to a person.',
    );
    expect(disclosureLine('Dastarkhwan', 'roman-ur')).toBe(
      'Dastarkhwan ka automated assistant. Kisi insaan se baat karne ke liye kabhi bhi “staff” likhein.',
    );
    // Right-to-left from its first character, with the name in its own isolate.
    expect(disclosureLine('دسترخوان', 'ur')).toBe(
      '\u200F\u2068دسترخوان\u2069 کا خودکار اسسٹنٹ۔ کسی انسان سے بات کرنے کے لیے کسی بھی وقت “عملہ” یا “staff” لکھیں۔',
    );
  });

  it('prefixes the first reply of a session, and only that one', () => {
    const first = withDisclosure('Dastarkhwan', chat([]), 'What would you like?', 'en', now);
    expect(first).toBe(`${line}\n\nWhat would you like?`);
    const sent = [{ id: 'r1', role: 'assistant' as const, text: first, createdAt: ago(60) }];
    expect(withDisclosure('Dastarkhwan', chat(sent), 'Anything else?', 'en', now)).toBe(
      'Anything else?',
    );
    // A day later, or after staff hand the chat back, it is a new session.
    const old = [{ ...sent[0]!, createdAt: ago(25 * 60) }];
    expect(withDisclosure('Dastarkhwan', chat(old), 'Hi again!', 'en', now)).toBe(
      `${line}\n\nHi again!`,
    );
    expect(needsDisclosure(chat(sent, ago(30)), now)).toBe(true);
    expect(needsDisclosure(chat(sent, ago(90)), now)).toBe(false);
  });

  it('counts only replies that carried it, and cannot be dropped by owner wording', () => {
    const menuCode = [
      { id: 'm1', role: 'assistant' as const, text: 'Order ORD-1 received.', createdAt: ago(5) },
    ];
    expect(withDisclosure('Dastarkhwan', chat(menuCode), 'Welcome!', 'en', now)).toBe(
      `${line}\n\nWelcome!`,
    );
    const roman = withDisclosure('Dastarkhwan', chat([]), 'Ji, menu yeh hai.', 'roman-ur', now);
    expect(roman.startsWith(disclosureLine('Dastarkhwan', 'roman-ur'))).toBe(true);
    expect(withDisclosure('Dastarkhwan', chat([]), '', 'en', now)).toBe('');
    expect(withDisclosure('Dastarkhwan', chat([]), `${line}\n\nHi`, 'en', now)).toBe(
      `${line}\n\nHi`,
    );
  });

  it.each(['staff', 'Staff!', 'human', 'insaan', 'staff please', 'عملہ', 'انسان؟'])(
    'hands “%s” to a person',
    (text) => expect(isStaffRequest(text)).toBe(true),
  );
  it.each([
    '2 biryani per person',
    'person',
    'staff ne kaha tha 2 biryani',
    'is staff available?',
    'my name is Human Khan',
  ])('does not read “%s” as asking for a person', (text) =>
    expect(isStaffRequest(text)).toBe(false),
  );
});
