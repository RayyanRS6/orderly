// FX-8: wording and small dashboard fixes. Transfer customers are told to ask the restaurant in
// WhatsApp (cash-only wording unchanged), Excel reads Urdu in the orders export, the example CSV
// can't replace a live menu, the Inbox names each kind of pause, and smaller fixes.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  paymentSentence,
  paymentShort,
  staffPaymentNote,
  staffTransferNote,
  transferAsk,
} from '../src/lib/payments';
import { csvCell, orderItems, ordersCsv, UTF8_BOM } from '../src/lib/orders-csv';
import { replaceMenuWarning } from '../src/components/Catalog';
import { describeCorrection } from '../src/shared/explain';
import { Inbox, pauseBadge } from '../src/components/Inbox';
import { ItemCard } from '../src/components/MenuPage';
import { Workspace } from '../src/lib/workspace';
import { seedConversations, seedOrders } from '../src/shared/seed';
import type { Conversation, Order, PaymentMethod } from '../src/shared/types';
import type { PublicMenuItem } from '../src/shared/menu';
import { bootstrap } from './prelaunch-e-helpers';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const all: PaymentMethod[] = ['cash', 'jazzcash', 'easypaisa', 'bank_transfer'];

describe('transfer wording on the menu page and the order cards', () => {
  it('tells the customer to ask the restaurant in WhatsApp for the details', () => {
    expect(paymentSentence(all, true)).toBe(
      'Pay cash on delivery, or by JazzCash, Easypaisa or bank transfer — ask the restaurant in WhatsApp for the details.',
    );
    expect(paymentSentence(['easypaisa', 'bank_transfer'], false)).toBe(
      'Pay by Easypaisa or bank transfer — ask the restaurant in WhatsApp for the details.',
    );
    expect(transferAsk(all)).toBe(
      'To pay by transfer, ask the restaurant in WhatsApp for the details.',
    );
    expect(staffTransferNote(['cash', 'jazzcash'])).toMatch(
      /^A customer paying by transfer asks you for the payment details in WhatsApp\. Check each transfer yourself/,
    );
    // Never a claim that a payment was received, and never an account number.
    for (const text of [paymentSentence(all, true), transferAsk(all), staffTransferNote(all)]) {
      expect(text).not.toMatch(/received|paid\b|confirmed/i);
      expect(text).not.toMatch(/\d{6,}/);
    }
  });

  it('keeps every cash-only word as it was', () => {
    expect(paymentSentence(['cash'], true)).toBe('Pay cash on delivery.');
    expect(paymentSentence(['cash'], false)).toBe('Pay cash at pickup.');
    expect(paymentShort(['cash'])).toBe('pay in cash');
    expect(staffPaymentNote(['cash'], true)).toBe('cash on delivery');
    expect(transferAsk(['cash'])).toBe('');
    expect(staffTransferNote(['cash'])).toBe('');
    expect(transferAsk([])).toBe('');
  });

  it('shows the ask on the placed-order card and the staff order card only with transfers', () => {
    const menu = source('src/components/MenuPage.tsx');
    expect(menu).toMatch(
      /\{transferAsk\(paymentMethodsOf\(restaurant\)\) && \(\s*<p[^>]*>\s*\{transferAsk\(paymentMethodsOf\(restaurant\)\)\}/,
    );
    const orders = source('src/components/Orders.tsx');
    expect(orders).toMatch(
      /\{staffTransferNote\(paymentMethodsOf\(data\.company\)\) && \(\s*<p[^>]*>\s*\{staffTransferNote\(paymentMethodsOf\(data\.company\)\)\}/,
    );
  });
});

describe('the orders export in Excel', () => {
  const order = (extra: Partial<Order> = {}): Order => ({
    ...seedOrders[0]!,
    customerName: 'علی',
    address: 'گلبرگ، لاہور',
    ...extra,
  });

  it('starts with a UTF-8 byte-order mark, so Urdu reads as written', async () => {
    expect(UTF8_BOM).toBe('﻿');
    expect(source('src/components/Orders.tsx')).toContain(
      "new Blob([UTF8_BOM, csv], { type: 'text/csv;charset=utf-8' })",
    );
    const bytes = new Uint8Array(
      await new Blob([UTF8_BOM, ordersCsv([order()], 'Asia/Karachi')]).arrayBuffer(),
    );
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain('"علی"');
    // The formula guard still applies.
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
  });

  it('exports an older line saved without notes or options', () => {
    const legacy = order({
      items: [
        { productId: 'p', name: 'Naan', quantity: 2, unitPrice: 5000, total: 10000 } as never,
      ],
    });
    expect(orderItems(legacy)).toBe('2 x Naan');
    expect(() => ordersCsv([legacy], 'Asia/Karachi')).not.toThrow();
  });
});

describe('importing a menu CSV', () => {
  it('says how many items the import replaces', () => {
    expect(replaceMenuWarning(28)).toBe(
      'This replaces your whole menu: the 28 items on it now are removed unless they are in this CSV.',
    );
    expect(replaceMenuWarning(1)).toMatch(/the 1 item on it now/);
    expect(replaceMenuWarning(0)).toBe(
      'This replaces the entire menu. Items absent from the CSV will be removed.',
    );
  });

  it('offers the example CSV only while the menu is empty', () => {
    const catalog = source('src/components/Catalog.tsx');
    expect(catalog).toContain('const menuEmpty = !data.products.length;');
    expect(catalog).toMatch(
      /\{menuEmpty && \(\s*<button[\s\S]*?onClick=\{\(\) => setCsv\(sample\)\}/,
    );
    expect(catalog).toContain('description={replaceMenuWarning(data.products.length)}');
    // The format is still shown in the empty box.
    expect(catalog).toContain('placeholder={sample}');
  });
});

describe('the allergy explanation for staff', () => {
  it('does not say staff were asked to check when the approved answer was sent', () => {
    const text = describeCorrection('allergy_question_guarded');
    expect(text).not.toContain('staff were asked to check');
    expect(text).toBe(
      'The customer asked about allergies, so your approved allergy answer was sent word for word; without one, a fixed safety notice was sent and the chat went to staff.',
    );
  });
});

describe('Inbox badges for each kind of pause', () => {
  const paused = (
    id: string,
    reason: NonNullable<Conversation['limitPause']>['reason'],
  ): Conversation => ({
    ...seedConversations[0]!,
    id,
    customerName: `Customer ${id}`,
    channel: 'whatsapp',
    mode: 'human',
    limitPause: {
      reason,
      at: new Date().toISOString(),
      until: new Date(Date.now() + 3600000).toISOString(),
      limit: 25,
    },
  });

  it('names a burst, an AI error and a late message, and keeps “AI limit” for limits', () => {
    expect(pauseBadge('burst')).toBe('Many messages');
    expect(pauseBadge('ai_error')).toBe('AI error');
    expect(pauseBadge('late')).toBe('Late message');
    for (const reason of ['hourly', 'monthly', 'customer'] as const)
      expect(pauseBadge(reason)).toBe('AI limit');
    const html = renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        {
          value: {
            data: bootstrap({
              conversations: [
                paused('a', 'burst'),
                paused('b', 'ai_error'),
                paused('c', 'late'),
                paused('d', 'hourly'),
              ],
            }),
            busy: false,
            error: '',
            clearError: () => {},
            page: 'inbox',
            navigate: () => {},
            switchCompany: () => {},
            refresh: async () => {},
            notify: () => {},
            mutate: async <T>() => ({}) as T,
          },
        },
        createElement(Inbox),
      ),
    );
    for (const label of ['Many messages', 'AI error', 'Late message'])
      expect(html.match(new RegExp(`>${label}<`, 'g')), label).toHaveLength(1);
    expect(html.match(/>AI limit</g)).toHaveLength(1);
  });
});

describe('menu prices with sizes', () => {
  const item: PublicMenuItem = {
    id: 'p1',
    name: 'Chicken Biryani',
    description: '',
    price: 45000,
    available: true,
    emoji: '🍛',
    variants: [
      { id: 'v1', name: 'Half', price: 45000 },
      { id: 'v2', name: 'Full', price: 80000 },
    ],
    modifiers: [],
  };
  const card = (i: PublicMenuItem) =>
    renderToStaticMarkup(
      createElement(ItemCard, {
        item: i,
        ordering: true,
        inCart: 0,
        picking: false,
        onPick: () => {},
        onAdd: () => {},
      }),
    ).replace(/<!-- -->/g, '');

  it('shows the cheapest size as a starting price', () => {
    expect(card(item)).toContain('from Rs. 450');
    // One price, or all sizes at one price: no “from”.
    expect(card({ ...item, variants: [] })).not.toContain('from ');
    expect(
      card({ ...item, variants: item.variants.map((v) => ({ ...v, price: 45000 })) }),
    ).not.toContain('from ');
  });
});

describe('opening the workspace after a failed first load', () => {
  it('forgets the saved business only when this account can no longer open it', () => {
    const app = source('src/App.tsx');
    expect(app).toMatch(
      /companyId &&\s*!route\.slug &&\s*e instanceof ApiError &&\s*\(e\.status === 403 \|\| e\.status === 404\)\s*\) \{\s*removeStoredCompany\(\);/,
    );
  });

  it('leaves no order count or business name in the tab title after signing out', () => {
    const app = source('src/App.tsx');
    expect(app).toMatch(
      /if \(!data\) \{\s*document\.title = 'Orderly — Conversations to orders';\s*return;\s*\}/,
    );
  });
});
