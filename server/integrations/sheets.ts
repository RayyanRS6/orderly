import { createSign } from 'node:crypto';
import type { Integration, Order, Product } from '../../src/shared/types.js';
import { PublicError } from '../security.js';
import { catalogFromRows, catalogHeaders } from './catalog.js';
import { GOOGLE_REAUTH, forgetGoogleAccessToken, googleAccessToken } from './google-oauth.js';

export const ORDER_HEADERS = [
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

/**
 * Why Google refused a Sheets request, in words that name the fix. Google answers a disabled
 * Sheets API and a missing share alike with 403; only the first carries SERVICE_DISABLED.
 */
async function sheetsRefusal(
  response: Response,
  config: Record<string, string>,
): Promise<{ message: string; code?: string }> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; details?: { reason?: unknown }[] };
  } | null;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const message = String(body?.error?.message ?? '');
  const disabled = response.status === 403 && details.some((d) => d?.reason === 'SERVICE_DISABLED');
  // Connected with Google: the Sheet is one Orderly made, in Orderly's own Google project.
  if (config.auth === 'oauth') {
    if (disabled)
      return { message: 'Google Sheets isn’t turned on for Orderly. Contact Orderly support.' };
    if (response.status === 403 || response.status === 404)
      return {
        message:
          'Orderly can no longer open your Sheet: it was deleted, or Google no longer lets Orderly use it. Click Reconnect Google in Integrations → Google Sheets to make a new one.',
        code: GOOGLE_REAUTH,
      };
    if (response.status === 429)
      return { message: 'Google Sheets is rate limited; synchronization will retry.' };
    // A range naming a tab the owner renamed or deleted.
    if (response.status === 400 && /unable to parse range/i.test(message))
      return {
        message:
          'Orderly can’t find the Orders or Menu tab in your Sheet. Rename the tab back to “Orders” (or “Menu”), then test again.',
      };
    return { message: 'Google Sheets request failed. Orderly will try again.' };
  }
  return { message: keyRefusal(response.status, message, disabled, config.clientEmail?.trim()) };
}
// Connected with a key file: the owner's own Google Cloud project, and their own share.
function keyRefusal(status: number, message: string, disabled: boolean, email?: string): string {
  if (disabled) {
    // The key's project is in its email: name@PROJECT.iam.gserviceaccount.com.
    const project = /@([\w-]+)\.iam\.gserviceaccount\.com$/.exec(email ?? '')?.[1];
    return `The Google Sheets API is turned off in ${project ? `your Google Cloud project “${project}”` : 'the Google Cloud project that made this key'}. Turn it on for that project (step 3b in Connect), wait a few minutes, then test again.`;
  }
  if (status === 403)
    return email
      ? `Share the spreadsheet with the service account ${email} as Editor.`
      : 'Share the spreadsheet with the service account as Editor.';
  if (status === 404)
    return 'Google found no spreadsheet at this link. Copy the link of your Sheet again.';
  if (status === 429) return 'Google Sheets is rate limited; synchronization will retry.';
  // An .xlsx file opened in Google Sheets: the Sheets API only works on Google Sheets files.
  if (status === 400 && /not supported for this document/i.test(message))
    return 'This is an Excel file, not a Google Sheet. Open it in Google Sheets, choose File → Save as Google Sheets, and connect the new Sheet’s link.';
  return 'Google Sheets request failed. Verify the spreadsheet and tab names.';
}

export interface CatalogSource {
  readCatalog(companyId: string): Promise<Product[]>;
}
export interface OrderDestination {
  syncOrder(order: Order): Promise<void>;
}
export class GoogleSheetsAdapter implements CatalogSource, OrderDestination {
  constructor(
    private integration: Integration,
    // A service account's private key, or the refresh token of a "Connect with Google".
    private credential: string,
  ) {}
  private async token(): Promise<string> {
    if (this.integration.config.auth === 'oauth') return googleAccessToken(this.credential);
    const email = this.integration.config.clientEmail;
    if (!email || !this.credential)
      throw new PublicError('Upload the Google key file in Integrations → Google Sheets.');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    let signature: string;
    try {
      signature = signer.sign(this.credential.replace(/\\n/g, '\n'), 'base64url');
    } catch {
      // A cut-off or mistyped private key, which Node refuses before Google sees it.
      throw new PublicError(
        'The saved private key is not a valid Google key. Upload the key file again in Integrations → Google Sheets.',
      );
    }
    const jwt = `${unsigned}.${signature}`;
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
        'Google rejected the service account key. If you made the key just now, wait a minute and test again; otherwise upload a new key file in Integrations → Google Sheets.',
        502,
      );
    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }
  private base(): string {
    const id = this.integration.config.spreadsheetId;
    if (!/^[\w-]{15,150}$/.test(id || ''))
      throw new PublicError('Paste your Google Sheet’s link in Integrations → Google Sheets.');
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
    if (!response.ok) {
      // A cached Google access token refused: the next try asks Google afresh.
      if (response.status === 401 && this.integration.config.auth === 'oauth')
        forgetGoogleAccessToken(this.credential);
      const { message, code } = await sheetsRefusal(response, this.integration.config);
      throw new PublicError(message, 502, code ? { code } : undefined);
    }
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
    // A Sheet connected with Google uses the tab names Orderly gave it.
    const google = this.integration.config.auth === 'oauth';
    if (missing(orders))
      throw new PublicError(
        google
          ? `Your Sheet has no tab named “${orders}” any more. Rename the orders tab back to “${orders}”, then test again.`
          : `The spreadsheet has no tab named “${orders}”. Add it for order copies, or change the orders tab name.`,
      );
    const menu = this.integration.config.catalogSheet || 'Menu';
    if (options.menuFor && missing(menu))
      throw new PublicError(
        google
          ? `Your Sheet has no tab named “${menu}”. Add a tab with that name holding your menu, then test again.`
          : `The spreadsheet has no tab named “${menu}”. Add your menu there, or change the menu tab name.`,
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
    if (values.length && values[0]?.[0] !== ORDER_HEADERS[0]) {
      const name = this.integration.config.ordersSheet || 'Orders';
      throw new PublicError(
        `Your “${name}” tab already has other data in it. The orders tab must be empty or begin with the Order ID header: rename that tab (for example to Old), add a new empty tab named ${name}, then test again.`,
      );
    }
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
