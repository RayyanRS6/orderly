import type { Order } from '../shared/types';

// The Orders export, kept apart from Orders.tsx so it can be tested. Columns are what a daily
// cash-up needs: what was ordered, what it cost, where it went and when, in the restaurant's
// own time zone.

/** "2026-10-18 14:05" in the restaurant's time zone; the stored UTC time if the zone is unknown. */
export function localTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  } catch {
    return date.toISOString();
  }
}

/** One cell: quoted, and never read as a formula by a spreadsheet. */
export function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+@\-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
}

/**
 * "2 x Zinger Burger (Large, Extra cheese) - no onions; 1 x Fries". An older saved line without
 * notes or options still exports.
 */
export const orderItems = (order: Order) =>
  order.items
    .map((line) => {
      const options = [line.variant, ...(line.modifiers ?? [])].filter(Boolean).join(', ');
      const notes = (line.notes ?? '').trim();
      return `${line.quantity} x ${line.name}${options ? ` (${options})` : ''}${
        notes ? ` - ${notes}` : ''
      }`;
    })
    .join('; ');

/** Put before the CSV text so Excel reads the file as UTF-8 (Urdu names and addresses). */
export const UTF8_BOM = '﻿';

export const ORDER_CSV_FIELDS = [
  'reference',
  'customer',
  'phone',
  'fulfillment',
  'zone',
  'address',
  'items',
  'subtotal_pkr',
  'delivery_fee_pkr',
  'total_pkr',
  'status',
  'source',
  'created_local',
  'updated_local',
];

export function ordersCsv(orders: Order[], timeZone: string) {
  return [
    ORDER_CSV_FIELDS,
    ...orders.map((o) => [
      o.reference,
      o.customerName,
      o.customerPhone,
      o.fulfillment,
      o.zone ?? '',
      o.address ?? '',
      orderItems(o),
      o.subtotal / 100,
      o.deliveryFee / 100,
      o.total / 100,
      o.status,
      o.source === 'menu_page' ? 'menu page' : 'chat',
      localTime(o.createdAt, timeZone),
      localTime(o.updatedAt, timeZone),
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}
