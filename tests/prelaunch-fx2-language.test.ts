// customer-wording-4: the cancellation reply, order status notices, the menu-outage handoff and
// refused pickup/delivery choices are said in the customer's language (English, Urdu, Roman
// Urdu), without internal terms.
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret, PublicError } from '../server/security';
import { localizedRefusals } from '../server/service';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import { defaultBot } from '../src/shared/bot';
import type { Company } from '../src/shared/types';
import { company, turnStore } from './helpers/fx2-turns';
import { demoApp, placedOrder } from './helpers/demo-app';

const { repo, chat, say, waitingOrder } = turnStore();
const app = demoApp();

describe('customer-wording-4: order messages in the customer’s language', () => {
  it('confirms a cancellation in Urdu and Roman Urdu', async () => {
    const urdu = await waitingOrder({ language: 'ur' });
    const cancelled = await say(company, urdu.conversation, 'منسوخ');
    expect(cancelled.result.order?.status).toBe('cancelled');
    expect(cancelled.result.reply).toContain(`آرڈر ${urdu.order.reference} منسوخ کر دیا گیا ہے۔`);
    expect(cancelled.result.reply).not.toContain('has been cancelled');
    const roman = await waitingOrder({ language: 'roman-ur' });
    const done = await say(company, roman.conversation, 'mera order cancel kardo');
    expect(done.result.reply).toContain(`Order ${roman.order.reference} cancel kar diya gaya hai.`);
    // What the customer is sent is what the chat keeps.
    expect(done.saved.messages.at(-1)!.text).toBe(done.result.reply);
  });

  it('refuses delivery at a pickup-only restaurant in Urdu, without jargon', async () => {
    const config = { ...defaultBot, fulfillment: 'pickup' as const };
    const pickupOnly: Company = {
      ...company,
      bot: {
        draft: config,
        revision: 1,
        history: [],
        published: { version: 1, config, publishedAt: new Date().toISOString(), publishedBy: 't' },
      },
    };
    await repo().saveCompany(pickupOnly);
    const turn = await say(pickupOnly, chat({ language: 'ur' }), 'ڈیلیوری', {
      action: { type: 'set_details', fulfillment: 'delivery' },
    });
    expect(turn.result.reply).toContain('ابھی صرف پک اپ دستیاب ہے۔ براہ کرم پک اپ منتخب کریں۔');
    expect(turn.result.reply).not.toContain('This restaurant currently offers');
    expect(turn.saved.messages.at(-1)!.text).toBe(turn.result.reply);
  });

  it('words every engine refusal of a pickup or delivery choice in the customer’s language', () => {
    expect(
      localizedRefusals(
        'This restaurant currently offers pickup only. Please update your fulfillment choice.',
        'en',
      ),
    ).toBe('This restaurant currently offers pickup only. Please choose pickup.');
    expect(localizedRefusals('This restaurant currently offers pickup only.', 'en')).toBe(
      'This restaurant currently offers pickup only.',
    );
    expect(
      localizedRefusals(
        'Items subtotal: Rs 900.\n\nThis restaurant currently offers delivery only. Please update your fulfillment choice.',
        'roman-ur',
      ),
    ).toBe(
      'Items subtotal: Rs 900.\n\nAbhi sirf delivery available hai. Meherbani karke delivery chunein.',
    );
    expect(
      localizedRefusals(
        'Ordering in this chat is not available right now. Please ask our staff for help.',
        'ur',
      ),
    ).toBe('ابھی اس چیٹ میں آرڈر دستیاب نہیں ہے۔ براہ کرم عملے سے رابطہ کریں۔');
    expect(localizedRefusals('We deliver to: DHA, Gulberg.', 'ur')).toBe(
      'ہم ان علاقوں میں ڈیلیوری کرتے ہیں: DHA, Gulberg۔',
    );
    expect(localizedRefusals('We do not deliver right now.', 'roman-ur')).toBe(
      'Abhi hum delivery nahi kar rahe.',
    );
    // Anything else is left alone.
    expect(localizedRefusals('Here is our menu.', 'ur')).toBe('Here is our menu.');
  });

  it('tells a customer in Urdu that the menu cannot be loaded, without internal terms', async () => {
    await repo().saveIntegration(
      company.id,
      {
        kind: 'sheets',
        configured: true,
        status: 'connected',
        config: { spreadsheetId: 'sheet-id', catalogSheet: 'Menu' },
      },
      encryptSecret('unused-private-key'),
    );
    vi.spyOn(GoogleSheetsAdapter.prototype, 'readCatalog').mockRejectedValue(
      new PublicError('The Sheet cannot be read.', 422),
    );
    const sheetMenu: Company = { ...company, catalogSource: 'sheets', catalogSyncedAt: undefined };
    await repo().saveCompany(sheetMenu);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    const turn = await say(sheetMenu, chat(), 'مینو دکھائیں');
    expect(turn.saved.mode).toBe('human');
    expect(turn.result.reply).toContain(
      'ابھی ہمارا مینو لوڈ نہیں ہو رہا۔ عملے کا ایک رکن یہیں آپ کے آرڈر میں مدد کرے گا۔',
    );
    expect(turn.result.reply).not.toContain('menu connection');
    // The next minute: this chat makes its own (failing) refresh attempt.
    vi.setSystemTime(new Date('2026-10-20T10:01:30.000Z'));
    const english = await say(sheetMenu, chat(), 'show me the menu');
    expect(english.result.reply).toContain(
      'We can’t load our menu right now. A staff member will reply here to help with your order.',
    );
  });
});

describe('customer-wording-4: order status notices in the customer’s language', () => {
  it('sends the Urdu status line and keeps exactly that copy in the chat', async () => {
    const { order, chat: placed } = await placedOrder(app.repo(), '+923001110077');
    await app
      .repo()
      .saveConversation({ ...placed, language: 'ur', version: placed.version + 1 }, placed.version);
    // Accept takes the order straight to 'preparing': the notice says both.
    const response = await app.request(`/orders/${order.id}/status`, {
      body: { status: 'preparing' },
    });
    expect(response.status).toBe(200);
    const text = `ریسٹورنٹ نے آرڈر ${order.reference} منظور کر لیا ہے اور یہ اب تیار ہو رہا ہے۔`;
    const send = (await app.repo().listCompanyJobs(company.id)).find(
      (j) => j.kind === 'whatsapp_send' && j.payload.orderId === order.id,
    )!;
    expect(send.payload).toMatchObject({ text, reference: order.reference, status: 'preparing' });
    const notice = (await app.repo().getConversation(company.id, placed.id))!.messages.at(-1)!;
    expect(notice).toMatchObject({ role: 'staff', text, notice: true });
  });

  it('keeps the English line for an English chat, also from a dashboard that still says accepted', async () => {
    const { order, chat: placed } = await placedOrder(app.repo(), '+923001110078');
    const response = await app.request(`/orders/${order.id}/status`, {
      body: { status: 'accepted' },
    });
    expect(await response.json()).toMatchObject({ status: 'preparing' });
    expect((await app.repo().getConversation(company.id, placed.id))!.messages.at(-1)!.text).toBe(
      `Order ${order.reference} has been accepted and is being prepared now.`,
    );
  });
});
