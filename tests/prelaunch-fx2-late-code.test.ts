// ai-pipeline-2 (G7.2): a menu-page order code that reaches Orderly 10 minutes to 2 hours late is
// never placed by itself. The customer sees the order again and sends the code once more.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hmacHex } from '../server/security';
import { createConversation } from '../src/domain/engine';
import { quoteWebCart } from '../src/domain/web-order';
import type { WebCart } from '../src/shared/menu';
import type { Company } from '../src/shared/types';
import { company, products, turnStore } from './helpers/fx2-turns';

const { repo, say } = turnStore();
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const cart: WebCart = {
  items: [{ productId: biryani.id, quantity: 2, modifierIds: [], notes: '' }],
  fulfillment: 'pickup',
  customerName: 'Ali',
};
const CODE = 'ABCDEFGH';
const text = 'Hi! Please place my menu order. Code: OM-ABCD-EFGH';
const codeHash = (code: string) => hmacHex('menu-draft', `${company.id}:code:${code}`);
// A code made on the menu page for this number, valid for 30 minutes from now.
async function codeFor(phone = '923001234567', code = CODE) {
  await repo().setMenuLink(company.id, true, company.slug);
  const created = await repo().createMenuDraft(
    {
      id: randomUUID(),
      companyId: company.id,
      codeHash: codeHash(code),
      phoneHash: hmacHex('menu-draft', `${company.id}:phone:${phone}`),
      cart,
      quotedTotal: quoteWebCart(company, products, cart).quote.total,
    },
    30,
    2000,
  );
  expect(created.ok).toBe(true);
  return createConversation(company.id, phone, 'whatsapp', '1970-01-01T00:00:00.000Z');
}
const pageOrders = async () =>
  (await repo().listOrders(company.id)).filter((o) => o.source === 'menu_page');

describe('ai-pipeline-2: a menu-page code that arrives late is not placed by itself', () => {
  it('shows the order and asks for the code again; the code sent again places it', async () => {
    const conversation = await codeFor();
    const late = await say(company, conversation, text, {
      now: new Date(Date.now() - 20 * 60000).toISOString(),
      late: true,
    });
    expect(late.result.order).toBeUndefined();
    expect(late.result.reply).toContain(
      'Sorry for the delay. Your message reached us late, so this order has not been placed yet:',
    );
    expect(late.result.reply).toContain('2 × Chicken Biryani');
    expect(late.result.reply).toContain('To place it, send this code again: OM-ABCD-EFGH');
    expect(await pageOrders()).toHaveLength(0);
    expect((await repo().findMenuDraft(company.id, codeHash(CODE)))?.usedAt).toBeUndefined();
    expect(late.saved.mode).toBe('bot');
    // The customer's own fresh message places it.
    const fresh = await say(company, conversation, text);
    expect(fresh.result.order).toMatchObject({ status: 'pending', source: 'menu_page' });
    expect(await pageOrders()).toHaveLength(1);
  });

  it('asks in the customer’s language', async () => {
    const conversation = await codeFor();
    const late = await say(company, conversation, 'میرا آرڈر کوڈ OM-ABCD-EFGH', {
      now: new Date(Date.now() - 20 * 60000).toISOString(),
      late: true,
    });
    expect(late.result.reply).toContain('تاخیر کے لیے معذرت۔');
    expect(late.result.reply).toContain('آرڈر دینے کے لیے یہ کوڈ دوبارہ بھیجیں: OM-ABCD-EFGH');
    expect(await pageOrders()).toHaveLength(0);
  });

  it('checks the code’s expiry and the opening hours when it is handled, not when it was sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T05:50:00.000Z'));
    const conversation = await codeFor();
    // Valid when sent (10:55 in Karachi), expired when it reached Orderly 40 minutes later.
    vi.setSystemTime(new Date('2026-10-20T06:30:00.000Z'));
    const expired = await say(company, conversation, text, {
      now: '2026-10-20T05:55:00.000Z',
      late: true,
    });
    expect(expired.result.reply).toContain('This order code has expired or was already used.');
    // Open when sent, closed when handled.
    const shortHours: Company = {
      ...company,
      openingHours: { start: '10:00', end: '11:00', days: [0, 1, 2, 3, 4, 5, 6] },
    };
    await repo().saveCompany(shortHours);
    vi.setSystemTime(new Date('2026-10-20T05:50:00.000Z'));
    const other = await codeFor('923007654321', 'HGFEDCBA');
    vi.setSystemTime(new Date('2026-10-20T06:10:00.000Z'));
    const closed = await say(shortHours, other, 'Code: OM-HGFE-DCBA', {
      now: '2026-10-20T05:55:00.000Z',
      late: true,
    });
    expect(closed.result.reply).toContain('We are currently closed.');
    expect(await pageOrders()).toHaveLength(0);
  });
});
