import { createSign } from 'node:crypto';
import type { Integration, Order, Product } from '../../src/shared/types.js';
import { PublicError } from '../security.js';
import { catalogFromRows } from './catalog.js';

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
  async test(): Promise<void> {
    const token = await this.token();
    await this.request('?fields=spreadsheetId,sheets.properties.title', token);
  }
  async readCatalog(companyId: string): Promise<Product[]> {
    const token = await this.token();
    const range = `${this.sheet(this.integration.config.catalogSheet || 'Menu')}!A1:J502`;
    const data = await this.request(`/values/${encodeURIComponent(range)}`, token);
    return catalogFromRows(companyId, data.values ?? []);
  }
  async syncOrder(order: Order): Promise<void> {
    const token = await this.token();
    const sheet = this.sheet(this.integration.config.ordersSheet || 'Orders');
    const headers = [
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
    const data = await this.request(`/values/${encodeURIComponent(`${sheet}!A:A`)}`, token);
    const values: string[][] = data.values ?? [];
    if (values.length && values[0]?.[0] !== 'Order ID')
      throw new PublicError('The orders tab must be empty or begin with the Order ID header.');
    if (!values.length)
      await this.request(
        `/values/${encodeURIComponent(`${sheet}!A1:M1`)}?valueInputOption=RAW`,
        token,
        { method: 'PUT', body: JSON.stringify({ values: [headers] }) },
      );
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
