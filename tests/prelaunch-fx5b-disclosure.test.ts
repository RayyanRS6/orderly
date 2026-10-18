// The start-of-chat notice names the business's AI assistant, in the words of the AI providers'
// disclosure rule. A chat told in the earlier "automated assistant" wording is not told again
// the same day.
import { describe, expect, it } from 'vitest';
import { disclosureLine, needsDisclosure, withDisclosure } from '../src/domain/disclosure';

const now = '2026-09-09T13:30:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60000).toISOString();

describe('the start-of-chat notice says it is the business’s AI assistant', () => {
  it('reads naturally in each language and keeps the Urdu line right-to-left', () => {
    expect(disclosureLine('Laziza', 'en')).toBe(
      'Laziza’s AI assistant. Type “staff” anytime to talk to a person.',
    );
    expect(disclosureLine('Laziza', 'roman-ur')).toBe(
      'Laziza ka AI assistant. Kisi insaan se baat karne ke liye kabhi bhi “staff” likhein.',
    );
    expect(disclosureLine('Laziza', 'ur')).toBe(
      '‏⁨Laziza⁩ کا اے آئی اسسٹنٹ۔ کسی انسان سے بات کرنے کے لیے کسی بھی وقت “عملہ” یا “staff” لکھیں۔',
    );
    expect(disclosureLine('  ', 'en')).toBe(
      'This restaurant’s AI assistant. Type “staff” anytime to talk to a person.',
    );
  });

  it('counts a notice in the new or the earlier wording, so a chat is told once a day', () => {
    const sent = (text: string) => ({
      messages: [{ id: 'r1', role: 'assistant' as const, text, createdAt: ago(60) }],
    });
    for (const lang of ['en', 'ur', 'roman-ur'] as const)
      expect(needsDisclosure(sent(`${disclosureLine('Laziza', lang)}\n\nHi`), now), lang).toBe(
        false,
      );
    for (const earlier of [
      'Laziza’s automated assistant. Type “staff” anytime to talk to a person.\n\nHi',
      '‏⁨Laziza⁩ کا خودکار اسسٹنٹ۔ کسی انسان سے بات کرنے کے لیے کسی بھی وقت “عملہ” یا “staff” لکھیں۔',
      'Laziza ka automated assistant. Kisi insaan se baat karne ke liye kabhi bhi “staff” likhein.',
    ]) {
      expect(needsDisclosure(sent(earlier), now)).toBe(false);
      expect(withDisclosure('Laziza', sent(earlier), 'Anything else?', 'en', now)).toBe(
        'Anything else?',
      );
    }
    // A day later, a new session starts with the new wording.
    const yesterday = {
      messages: [
        {
          id: 'r1',
          role: 'assistant' as const,
          text: 'Laziza’s automated assistant. Type “staff” anytime to talk to a person.',
          createdAt: ago(25 * 60),
        },
      ],
    };
    expect(withDisclosure('Laziza', yesterday, 'Hi', 'en', now)).toBe(
      `${disclosureLine('Laziza', 'en')}\n\nHi`,
    );
  });
});
