import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Product } from '../../src/shared/types.js';
import { productSchema } from '../validation.js';
import { PublicError } from '../security.js';
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
export function catalogFromRows(companyId: string, rows: string[][]): Product[] {
  if (rows.length < 2) throw new PublicError('Add a header row and at least one menu item.');
  if (rows.length > 501) throw new PublicError('Import up to 500 menu items at a time.');
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  for (const required of ['name', 'category', 'price', 'available'])
    if (!headers.includes(required)) throw new PublicError(`Missing required column: ${required}.`);
  const products = rows
    .slice(1)
    .filter((row) => row.some((v) => String(v).trim()))
    .map((row, index) => {
      const v = Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? '').trim()]));
      try {
        const price = Number(v.price);
        if (!Number.isFinite(price) || price < 0 || !v.price) throw new Error('Invalid price');
        if (!['true', 'false', 'yes', 'no', '1', '0'].includes(v.available.toLowerCase()))
          throw new Error('Availability must be true or false');
        const options = (value: string) =>
          value
            ? z
                .array(z.object({ id: z.string(), name: z.string(), price: z.number() }))
                .parse(JSON.parse(value))
                .map((o) => ({ ...o, price: Math.round(o.price * 100) }))
            : [];
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
            available: ['true', 'yes', '1'].includes(v.available.toLowerCase()),
            emoji: v.emoji || '🍽️',
            aliases: (v.aliases || '').split('|').filter(Boolean),
            variants: options(v.variants),
            modifiers: options(v.modifiers),
          }),
          companyId,
        } as Product;
      } catch {
        throw new PublicError(
          `Row ${index + 2} is invalid. Check price, availability, and option JSON. No menu changes were saved.`,
        );
      }
    });
  if (new Set(products.map((p) => p.id)).size !== products.length)
    throw new PublicError('Menu item IDs must be unique.');
  return products;
}
