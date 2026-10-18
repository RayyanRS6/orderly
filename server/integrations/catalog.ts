import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Product } from '../../src/shared/types.js';
import { productSchema } from '../validation.js';
import { PublicError } from '../security.js';
import { isPhotoUrl } from '../../src/shared/menu.js';
export const catalogHeaders = [
  'id',
  'name',
  'description',
  'category',
  'price',
  'available',
  'emoji',
  'aliases',
  'variants',
  'modifiers',
  'image',
];
export function parseCsv(input: string): string[][] {
  if (input.length > 500000) throw new PublicError('CSV files must be smaller than 500 KB.');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const data = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '"') {
      if (quoted && data[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || cell === '') quoted = !quoted;
      else throw new PublicError('Invalid CSV quotation.');
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && data[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (quoted) throw new PublicError('CSV contains an unclosed quoted field.');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
function stableId(companyId: string, key: string): string {
  const h = createHash('sha256').update(`${companyId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// A cell as text. Sheets sends numbers and checkboxes as JSON numbers and booleans.
const cellText = (value: unknown) =>
  typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
// Urdu and Arabic digits typed in a cell, as 0–9, with the Arabic decimal and group signs.
const latinDigits = (text: string) =>
  text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
/**
 * A menu price in rupees. A number cell is used as it is. Text may carry Rs, Rs., PKR or ₨
 * before it, /- after it, comma groups (1,200 or 1,20,000) and up to 2 decimals. Anything
 * else, such as 1.200 (a thousand or one rupee twenty?), 12,50 or 1e3, is refused, never
 * guessed.
 */
export function parsePrice(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = latinDigits(value)
    .trim()
    .replace(/^(?:rs\.?|pkr|₨)\s*/i, '')
    .replace(/\s*\/-$/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d{1,2})?$/.test(text))
    return undefined;
  return Number(text.replace(/,/g, ''));
}
const AVAILABLE = new Map([
  ...['true', 'yes', 'y', '1', 'available', 'in stock'].map((v) => [v, true] as const),
  ...['false', 'no', 'n', '0', 'unavailable', 'out of stock', 'sold out'].map(
    (v) => [v, false] as const,
  ),
]);
// A problem with one cell, reported with its row, column and value.
class CellError extends Error {}
const shown = (value: string) => `“${value.length > 40 ? `${value.slice(0, 40)}…` : value}”`;
export function catalogFromRows(companyId: string, rows: unknown[][]): Product[] {
  if (rows.length < 2) throw new PublicError('Add a header row and at least one menu item.');
  if (rows.length > 501) throw new PublicError('Import up to 500 menu items at a time.');
  const headers = rows[0].map((h) => cellText(h).toLowerCase());
  for (const required of ['name', 'category', 'price', 'available'])
    if (!headers.includes(required)) throw new PublicError(`Missing required column: ${required}.`);
  const products = rows
    .slice(1)
    // Numbered as in the sheet, counting blank rows, so "Row 7" is row 7.
    .map((row, index) => ({ row: row ?? [], number: index + 2 }))
    .filter(({ row }) => row.some((v) => cellText(v)))
    .map(({ row, number }) => {
      const raw = Object.fromEntries(headers.map((h, i) => [h, row[i]]));
      const v = Object.fromEntries(headers.map((h, i) => [h, cellText(row[i])]));
      try {
        for (const column of ['name', 'category'] as const)
          if (!v[column]) throw new CellError(`${column} is empty.`);
        const price = parsePrice(raw.price);
        if (price === undefined)
          throw new CellError(
            v.price
              ? `price: ${shown(v.price)} is not a price. Use a plain number such as 1200.`
              : 'price is empty.',
          );
        const available = AVAILABLE.get(v.available.toLowerCase());
        if (available === undefined)
          throw new CellError(
            `available: ${shown(v.available)} must be yes or no (or true or false).`,
          );
        const options = (column: 'variants' | 'modifiers') => {
          if (!v[column]) return [];
          try {
            return z
              .array(z.object({ id: z.string(), name: z.string(), price: z.number() }))
              .parse(JSON.parse(v[column]))
              .map((o) => ({ ...o, price: Math.round(o.price * 100) }));
          } catch {
            throw new CellError(`${column}: the option list is not valid JSON.`);
          }
        };
        // A missing or bad photo link is left out: it must never fail the row (or a Sheets sync).
        const photo = [v.image, v.image_url, v.photo].find((x) => x && isPhotoUrl(x));
        return {
          ...productSchema.parse({
            id: z.string().uuid().safeParse(v.id).success
              ? v.id
              : stableId(companyId, v.id || v.name.toLowerCase()),
            companyId,
            name: v.name,
            description: v.description || '',
            category: v.category,
            price: Math.round(price * 100),
            available,
            emoji: v.emoji || '🍽️',
            aliases: (v.aliases || '').split('|').filter(Boolean),
            variants: options('variants'),
            modifiers: options('modifiers'),
            imageUrl: photo,
          }),
          companyId,
        } as Product;
      } catch (error) {
        throw new PublicError(
          error instanceof CellError
            ? `Row ${number}, ${error.message} No menu changes were saved.`
            : `Row ${number} is invalid. Check price, availability, and option JSON. No menu changes were saved.`,
        );
      }
    });
  // A tab cleared down to stray spaces must not replace the live menu with nothing.
  if (!products.length)
    throw new PublicError('The menu has no items. Add at least one. No menu changes were saved.');
  if (new Set(products.map((p) => p.id)).size !== products.length)
    throw new PublicError('Menu item IDs must be unique.');
  return products;
}
