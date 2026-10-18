import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Overview, ordersChangeKey } from '../src/components/Orders';
import { csvCell, localTime, orderItems, ordersCsv } from '../src/lib/orders-csv';
import { seedOrders } from '../src/shared/seed';
import type { Order } from '../src/shared/types';
import { bootstrap, render } from './prelaunch-e-helpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('the Overview chart counts each day as the restaurant’s day', () => {
  it('puts orders between local midnight and 05:00 Karachi time on the right day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 02:30 on 19 October in Karachi is still 18 October in UTC.
    vi.setSystemTime(new Date('2026-10-18T21:30:00.000Z'));
    const html = render(
      Overview,
      bootstrap({
        orders: [],
        summary: {
          orders: 5,
          pending: 0,
          value: 0,
          conversations: 0,
          needsStaff: 0,
          monthlySpend: 0,
          // Buckets by the restaurant's own day, as the server does.
          daily: [
            { date: '2026-10-18', count: 1 },
            { date: '2026-10-19', count: 4 },
          ],
        },
      }),
      'overview',
    );
    // Both days are in the last 7 Karachi days; by UTC dates the 4 orders of today are lost.
    expect(html).toContain('5 orders in the last 7 days');
  });
});

describe('the orders export', () => {
  const order = (extra: Partial<Order> = {}): Order => ({
    ...seedOrders[0]!,
    reference: 'ORD-1',
    customerName: '=HYPERLINK("http://x")',
    customerPhone: '+923001234567',
    fulfillment: 'delivery',
    zone: 'DHA',
    address: 'House 1, Street "2"',
    items: [
      {
        productId: 'p1',
        name: 'Zinger Burger',
        quantity: 2,
        unitPrice: 65000,
        variant: 'Large',
        modifiers: ['Extra cheese'],
        notes: ' no onions ',
        total: 130000,
      },
      {
        productId: 'p2',
        name: 'Fries',
        quantity: 1,
        unitPrice: 25000,
        modifiers: [],
        notes: '',
        total: 25000,
      },
    ],
    subtotal: 155000,
    deliveryFee: 15000,
    total: 170000,
    status: 'completed',
    // 00:30 on 19 October in Karachi, still 18 October in UTC.
    createdAt: '2026-10-18T19:30:00.000Z',
    updatedAt: '2026-10-18T20:15:00.000Z',
    source: 'menu_page',
    ...extra,
  });

  it('has the columns a daily cash-up needs, with times in the restaurant’s day', () => {
    const [header, row] = ordersCsv([order()], 'Asia/Karachi').split('\r\n');
    expect(header).toBe(
      '"reference","customer","phone","fulfillment","zone","address","items","subtotal_pkr","delivery_fee_pkr","total_pkr","status","source","created_local","updated_local"',
    );
    expect(row).toBe(
      [
        '"ORD-1"',
        // Never run as a formula by a spreadsheet.
        `"'=HYPERLINK(""http://x"")"`,
        `"'+923001234567"`,
        '"delivery"',
        '"DHA"',
        '"House 1, Street ""2"""',
        '"2 x Zinger Burger (Large, Extra cheese) - no onions; 1 x Fries"',
        '"1550"',
        '"150"',
        '"1700"',
        '"completed"',
        '"menu page"',
        '"2026-10-19 00:30"',
        '"2026-10-19 01:15"',
      ].join(','),
    );
    // A pickup order has no zone or address: empty cells keep the columns in place.
    expect(
      ordersCsv(
        [order({ fulfillment: 'pickup', zone: undefined, address: undefined, deliveryFee: 0 })],
        'Asia/Karachi',
      ),
    ).toContain('"pickup","","","2 x Zinger');
  });

  it('keeps cells safe and times readable', () => {
    for (const formula of ['=1+1', '+1', '-1', '@SUM(A1)', '  =cmd'])
      expect(csvCell(formula).startsWith(`"'`)).toBe(true);
    expect(csvCell('Biryani')).toBe('"Biryani"');
    expect(localTime('2026-10-18T19:30:00.000Z', 'Not/AZone')).toBe('2026-10-18T19:30:00.000Z');
    expect(localTime('not a date', 'Asia/Karachi')).toBe('');
    expect(orderItems(order({ items: [] }))).toBe('');
    expect(ordersCsv([order({ source: undefined })], 'Asia/Karachi')).toContain('"chat"');
  });

  it('is built by the Orders page from these columns', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/Orders.tsx'), 'utf8');
    expect(source).toContain('const csv = ordersCsv(exportOrders, data.company.timezone);');
  });
});

describe('the Orders page asks again only when something changed', () => {
  it('ignores a refresh that brought the same orders, totals and events', () => {
    const data = bootstrap();
    expect(ordersChangeKey(structuredClone(data))).toBe(ordersChangeKey(data));
    const accepted = structuredClone(data);
    accepted.orders[0]!.status = 'accepted';
    expect(ordersChangeKey(accepted)).not.toBe(ordersChangeKey(data));
    // A change to an older order (not among the latest) still records an event.
    const recorded = bootstrap({
      traces: [
        { id: 'new-event', companyId: 'c', action: 'order.status', detail: '', createdAt: '' },
      ],
    });
    expect(ordersChangeKey(recorded)).not.toBe(ordersChangeKey(data));
  });
});
