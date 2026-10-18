import { createSign } from 'node:crypto';
import type { Integration, Order, Product } from '../../src/shared/types.js';
import { PublicError } from '../security.js';
import { catalogFromRows, catalogHeaders } from './catalog.js';

const ORDER_HEADERS = [
  'Order ID',
  'Reference',
  'Created',
  'Customer',
  'Phone',
  'Fulfillment',
  'Address',
  'Area',
  'Items',
  'Subtotal PKR',
  'Delivery PKR',
  'Total PKR',
  'Status',
];

export interface CatalogSource {
  readCatalog(companyId: string): Promise<Product[]>;
}
export interface OrderDestination {
  syncOrder(order: Order): Promise<void>;
}
export class GoogleSheetsAdapter implements CatalogSource, OrderDestination {
  constructor(
    private integration: Integration,
    private privateKey: string,
  ) {}
  private async token(): Promise<string> {
    const email = this.integration.config.clientEmail;
    if (!email || !this.privateKey)
      throw new PublicError('Add a Google service account email and private key.');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const jwt = `${unsigned}.${signer.sign(this.privateKey.replace(/\\n/g, '\n'), 'base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new PublicError(
        'Google rejected the service account credentials. Check the email and private key.',
        502,
      );
    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }
  private base(): string {
    const id = this.integration.config.spreadsheetId;
    if (!/^[\w-]{15,150}$/.test(id || ''))
      throw new PublicError('Enter the spreadsheet ID from its Google Sheets URL.');
    return `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  }
  private sheet(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
  }
  private async request(path: string, token: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(`${this.base()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw new PublicError(
        response.status === 403
          ? 'Share the spreadsheet with the service account as Editor.'
          : response.status === 429
            ? 'Google Sheets is rate limited; synchronization will retry.'
            : 'Google Sheets request failed. Verify the spreadsheet and tab names.',
        502,
      );
    return response.json();
  }
  /**
   * Checks what syncing needs, before any order depends on it: the orders tab exists and can
   * be written (Editor access, proved by rewriting its header cell), and, when the menu is
   * read from this Sheet (menuFor: the company), that the menu tab exists and its items parse.
   */
  async test(options: { menuFor?: string } = {}): Promise<void> {
    const token = await this.token();
    const meta = await this.request('?fields=spreadsheetId,sheets.properties.title', token);
    // Tab names match regardless of case, as in the Sheets API ranges used at runtime.
    const tabs = new Set(
      ((meta?.sheets ?? []) as { properties?: { title?: unknown } }[]).map((tab) =>
        String(tab?.properties?.title ?? '')
          .trim()
          .toLowerCase(),
      ),
    );
    const missing = (name: string) => !tabs.has(name.trim().toLowerCase());
    const orders = this.integration.config.ordersSheet || 'Orders';
    if (missing(orders))
      throw new PublicError(
        `The spreadsheet has no tab named “${orders}”. Add it for order copies, or change the orders tab name.`,
      );
    const menu = this.integration.config.catalogSheet || 'Menu';
    if (options.menuFor && missing(menu))
      throw new PublicError(
        `The spreadsheet has no tab named “${menu}”. Add your menu there, or change the menu tab name.`,
      );
    const sheet = this.sheet(orders);
    // An empty tab gets its header row, which already proves write access; otherwise the
    // header cell is rewritten with the same text.
    if ((await this.ordersColumn(token, sheet)).length)
      await this.request(
        `/values/${encodeURIComponent(`${sheet}!A1`)}?valueInputOption=RAW`,
        token,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [[ORDER_HEADERS[0]]] }),
        },
      );
    if (options.menuFor && !(await this.readCatalog(options.menuFor)).some((p) => p.available))
      throw new PublicError(
        'The menu tab has no available items. Mark at least one item available.',
      );
  }
  async readCatalog(companyId: string): Promise<Product[]> {
    const token = await this.token();
    // Whole rows: naming a last column could reach past a narrow tab's grid and fail the read.
    const range = `${this.sheet(this.integration.config.catalogSheet || 'Menu')}!1:502`;
    // Cell values, not their display text: 1,200 shown in any locale arrives as 1200, and a
    // checkbox as true or false. Dates stay as shown, so a name like 1/2 stays text.
    const data = await this.request(
      `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      token,
    );
    const rows: unknown[][] = data.values ?? [];
    // Columns are found by their header, in any order: the first column with each known
    // header is read, and every other column (a later repeat, notes, anything unknown) is
    // ignored. Inserting a column can no longer push sizes or add-ons out of the menu.
    const known = new Set([...catalogHeaders, 'image_url', 'photo']);
    const seen = new Set<string>();
    const keep = (rows[0] ?? []).flatMap((header, index) => {
      const name = String(header ?? '')
        .trim()
        .toLowerCase();
      if (!known.has(name) || seen.has(name)) return [];
      seen.add(name);
      return [index];
    });
    return catalogFromRows(
      companyId,
      rows.map((row) => keep.map((index) => row?.[index] ?? '')),
    );
  }
  // The orders tab's first column. An empty tab gets the header row; any other first cell
  // than the Order ID header is refused, so unrelated data is never overwritten.
  private async ordersColumn(token: string, sheet: string): Promise<string[][]> {
    const data = await this.request(`/values/${encodeURIComponent(`${sheet}!A:A`)}`, token);
    const values: string[][] = data.values ?? [];
    if (values.length && values[0]?.[0] !== ORDER_HEADERS[0])
      throw new PublicError('The orders tab must be empty or begin with the Order ID header.');
    if (!values.length)
      await this.request(
        `/values/${encodeURIComponent(`${sheet}!A1:M1`)}?valueInputOption=RAW`,
        token,
        { method: 'PUT', body: JSON.stringify({ values: [ORDER_HEADERS] }) },
      );
    return values;
  }
  async syncOrder(order: Order): Promise<void> {
    const token = await this.token();
    const sheet = this.sheet(this.integration.config.ordersSheet || 'Orders');
    const values = await this.ordersColumn(token, sheet);
    const row = [
      order.id,
      order.reference,
      order.createdAt,
      order.customerName,
      order.customerPhone,
      order.fulfillment,
      order.address || '',
      order.zone || '',
      order.items
        .map(
          (i) =>
            `${i.quantity} × ${i.name}${i.variant ? ` (${i.variant})` : ''}${i.modifiers.length ? ` + ${i.modifiers.join(', ')}` : ''}${i.notes ? ` [${i.notes}]` : ''}`,
        )
        .join('; '),
      order.subtotal / 100,
      order.deliveryFee / 100,
      order.total / 100,
      order.status,
    ];
    const matches = values.flatMap((v, i) => (v[0] === order.id ? [i + 1] : []));
    if (matches.length) {
      await this.request('/values:batchUpdate', token, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: matches.map((n) => ({ range: `${sheet}!A${n}:M${n}`, values: [row] })),
        }),
      });
      // Reconcile rare ambiguous append duplicates without deleting unrelated customer rows.
      if (matches.length > 1)
        await this.request('/values:batchClear', token, {
          method: 'POST',
          body: JSON.stringify({ ranges: matches.slice(1).map((n) => `${sheet}!A${n}:M${n}`) }),
        });
    } else {
      await this.request(
        `/values/${encodeURIComponent(`${sheet}!A:M`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        token,
        { method: 'POST', body: JSON.stringify({ values: [row] }) },
      );
    }
  }
}
