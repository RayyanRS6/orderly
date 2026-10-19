// Final review, fx-6 (customer-wording-1/6/9/11, conversation-7, ai-pipeline-3): Orderly's own
// words (a button title, a media or unreadable-message marker, a shared location, "staff")
// never switch a chat's language; refusals and the unreadable-message notice are said in the
// customer's language.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { handleTurn, localizedRefusals, statusNoticeText } from '../server/service';
import { MEDIA_HANDOFF_TEXT } from '../server/whatsapp/inbound';
import { asksToCancelOrder, noticeLanguage } from '../src/domain/engine';
import type { Company, Conversation } from '../src/shared/types';
import { turnStore } from './helpers/fx2-turns';
import {
  biryani,
  company,
  fresh,
  products,
  reviewed,
  step,
  turn,
  UNREAD,
  withBot,
} from './helpers/fx6-turns';

describe('Orderly’s own words never switch a chat’s language', () => {
  it('keeps Urdu after the Confirm button, and the status notice in Urdu', () => {
    const c = reviewed(company, 'ur');
    const confirmed = turn(company, c, 'Confirm order', { action: { type: 'confirm' } });
    expect(confirmed.order).toBeDefined();
    expect(confirmed.conversation.language).toBe('ur');
    expect(confirmed.reply).toContain('موصول ہوا');
    expect(statusNoticeText(company, confirmed.conversation, confirmed.order!, 'accepted')).toBe(
      `ریسٹورنٹ نے آرڈر ${confirmed.order!.reference} منظور کر لیا ہے۔`,
    );
  });

  it('keeps Roman Urdu after a shared location, a voice note, “staff” or a photo', () => {
    const roman = turn(company, fresh(), 'mujhe 2 chicken biryani chahiye delivery').conversation;
    expect(roman.language).toBe('roman-ur');
    const located = turn(company, roman, 'Location shared: DHA Phase 5, Lahore (31.47, 74.41)');
    expect(located.conversation.language).toBe('roman-ur');
    const photo = turn(company, roman, '👍 (sent with a photo)');
    expect(photo.conversation.language).toBe('roman-ur');
    const voice = turn(company, roman, MEDIA_HANDOFF_TEXT, { action: { type: 'handoff' } });
    expect(voice.conversation.language).toBe('roman-ur');
    expect(voice.reply).toBe('Yeh conversation ab staff ke paas hai. Bot pause kar diya gaya hai.');
    const staff = turn(company, roman, 'staff');
    expect(staff.conversation.language).toBe('roman-ur');
    for (const text of [MEDIA_HANDOFF_TEXT, UNREAD, 'Location shared: Gulberg', 'confirm'])
      expect(noticeLanguage(company, { ...roman, language: 'ur' }, text), text).toBe('ur');
    // The customer's own English still switches it.
    expect(turn(company, roman, 'what is the total?').conversation.language).toBe('en');
  });
});

describe('refusals in the customer’s language', () => {
  const noOrdering: Company = withBot(
    { ...company, deliveryZones: [] },
    { fulfillment: 'delivery' },
  );
  const pickupOnly = withBot(company, { fulfillment: 'pickup' });

  it('says chat ordering is unavailable in Urdu and Roman Urdu', () => {
    for (const [lang, text] of [
      ['ur', 'ابھی اس چیٹ میں آرڈر دستیاب نہیں ہے۔ کسی انسان سے بات کرنے کے لیے “عملہ” لکھیں۔'],
      [
        'roman-ur',
        'Abhi is chat mein order available nahi hai. Kisi insaan se baat karne ke liye “staff” likhein.',
      ],
    ] as const) {
      let c: Conversation = fresh(lang);
      c = step(noOrdering, c, { type: 'add_item', productId: biryani.id, quantity: 1 });
      const refused = turn(noOrdering, c, 'pickup', {
        action: { type: 'set_details', fulfillment: 'pickup' },
      });
      expect(refused.reply).toBe(text);
      // The server's safety net matches the engine's current English wording too.
      expect(
        localizedRefusals(
          'Ordering in this chat is not available right now. Type “staff” to talk to a person.',
          lang,
        ),
      ).toBe(text);
    }
  });

  it('asks for the offered choice and names the delivery areas in the customer’s language', () => {
    let c: Conversation = fresh('roman-ur');
    c = step(company, c, { type: 'add_item', productId: biryani.id, quantity: 1 });
    c = step(company, c, { type: 'set_details', customerName: 'Ali', fulfillment: 'delivery' });
    const review = turn(pickupOnly, c, 'review', { action: { type: 'review' } });
    expect(review.reply).toBe('Abhi sirf pickup available hai. Meherbani karke pickup chunein.');
    const english = turn(pickupOnly, { ...c, language: 'en' }, 'review', {
      action: { type: 'review' },
    });
    expect(english.reply).toBe(
      'This restaurant currently offers pickup only. Please choose pickup.',
    );
    const zone = turn(company, { ...c, language: 'ur' }, 'Johar Town', {
      action: { type: 'set_details', zone: 'Johar Town' },
    });
    expect(zone.reply).toBe('ہم ان علاقوں میں ڈیلیوری کرتے ہیں: Gulberg, Model Town, DHA۔');
  });

  it('marks an unavailable choice in the customer’s language', () => {
    const beefId = '33333333-3333-4333-a333-0000000000b1';
    const sold = [
      ...products.filter((p) => p.id !== biryani.id),
      { ...biryani, available: false },
      { ...biryani, id: beefId, name: 'Beef Biryani', aliases: [] },
    ];
    const asked = turn(
      company,
      fresh('ur'),
      'step',
      { action: { type: 'clarify_item', candidateProductIds: [biryani.id, beefId], quantity: 1 } },
      undefined,
      undefined,
      sold,
    );
    expect(asked.reply).toContain('1. Chicken Biryani · دستیاب نہیں');
  });

  it('cancels with the word the reminder asks for, quotes and all', () => {
    expect(asksToCancelOrder('“منسوخ”')).toBe(true);
    expect(asksToCancelOrder('"cancel"')).toBe(true);
    expect(asksToCancelOrder('don’t cancel')).toBe(false);
  });
});

describe('a linked-phone message Orderly could not read', () => {
  const { repo, chat, say } = turnStore();
  const unread = (c: Conversation) =>
    handleTurn(repo(), company, c, {
      messageId: `${randomUUID()}:unread`,
      text: UNREAD,
      action: { type: 'handoff' },
      now: new Date().toISOString(),
    });

  it('asks the customer to send it again, in their language, and answers the next message', async () => {
    for (const [lang, notice] of [
      [
        'roman-ur',
        'Maazrat, hum aap ka pichhla message nahi parh sake. Meherbani karke dobara bhejein, ya staff ka koi member yahin jawab dega.',
      ],
      [
        'ur',
        'معذرت، ہم آپ کا پچھلا پیغام نہیں پڑھ سکے۔ براہ کرم دوبارہ بھیجیں، یا عملے کا ایک رکن یہیں جواب دے گا۔',
      ],
      [
        'en',
        'Sorry, we couldn’t read your last message. Please send it again, or a staff member will reply here.',
      ],
    ] as const) {
      const c = chat({ language: lang });
      const result = await unread(c);
      expect(result.reply, lang).toContain(notice);
      expect(result.reply).not.toContain('The bot is paused');
      const saved = (await repo().getConversation(company.id, c.id))!;
      expect(saved).toMatchObject({ mode: 'human', language: lang });
      expect(saved.limitPause?.reason).toBe('late');
      // Staff still see what happened.
      expect(saved.messages.find((m) => m.role === 'customer')?.text).toBe(UNREAD);
      // The real message arriving later is answered by the bot.
      const next = await say(company, saved, 'menu');
      expect(next.saved.mode).toBe('bot');
      expect(next.result.reply).toContain('Chicken Biryani');
    }
  });

  it('leaves a chat staff or a pause already hold as it was', async () => {
    const until = new Date(Date.now() + 15 * 60000).toISOString();
    const paused = chat({
      mode: 'human',
      limitPause: {
        reason: 'burst',
        at: new Date().toISOString(),
        until,
        limit: Number.MAX_SAFE_INTEGER,
      },
    });
    await unread(paused);
    const saved = (await repo().getConversation(company.id, paused.id))!;
    expect(saved.mode).toBe('human');
    expect(saved.limitPause).toMatchObject({ reason: 'burst', until });
    expect((await repo().listTraces(company.id)).some((t) => t.code === 'unread')).toBe(false);
  });
});
