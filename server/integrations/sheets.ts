import { createSign } from 'node:crypto';
import type { Integration, Order, Product } from '../../src/shared/types.js';
import { SEE_FIX, type SheetsProblem, projectOfHelper } from '../../src/shared/sheets-problems.js';
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

// Google didn't answer in time or at all: nothing is wrong with the connection.
const googleSilent = () =>
  new PublicError('Google didn’t answer. Orderly will try again.', 503, { code: 'GOOGLE_DOWN' });
const GOOGLE_BUSY_MESSAGE = 'Google Sheets is rate limited; synchronization will retry.';

/**
 * Why Google refused a Sheets request, in words that name the fix, with the code that opens the
 * guided fix. Google answers a disabled Sheets API, a missing share and a locked tab alike with
 * 403: only the first carries SERVICE_DISABLED, and a write refused after a read worked means
 * the helper account can look at the Sheet but not change it.
 */
async function sheetsRefusal(
  response: Response,
  config: Record<string, string>,
  writing: boolean,
): Promise<{ message: string; code: SheetsProblem }> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; details?: { reason?: unknown }[] };
  } | null;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const message = String(body?.error?.message ?? '');
  const disabled = response.status === 403 && details.some((d) => d?.reason === 'SERVICE_DISABLED');
  if (response.status === 429) return { message: GOOGLE_BUSY_MESSAGE, code: 'GOOGLE_BUSY' };
  if (response.status >= 500) return { message: googleSilent().message, code: 'GOOGLE_DOWN' };
  // A range naming a tab the owner renamed or deleted, found while it is being read. A quoted tab
  // name writes an apostrophe in it twice ('Joe''s Menu').
  const parsed = /unable to parse range:\s*(?:'((?:[^']|'')+)'|([^!]+))!/i.exec(message);
  const range = (parsed?.[1]?.replace(/''/g, "'") ?? parsed?.[2])?.trim().toLowerCase();
  if (response.status === 400 && range) {
    const menu = (config.catalogSheet || 'Menu').trim().toLowerCase();
    return range === menu
      ? {
          message: `Your Sheet has no tab named “${config.catalogSheet || 'Menu'}”. ${SEE_FIX}`,
          code: 'MENU_TAB_MISSING',
        }
      : {
          message: `Your Sheet has no tab named “${config.ordersSheet || 'Orders'}”. ${SEE_FIX}`,
          code: 'ORDERS_TAB_MISSING',
        };
  }
  if (/protected cell|protected range/i.test(message))
    return {
      message: `Part of your Orders tab is locked, so Orderly can’t add rows. ${SEE_FIX}`,
      code: 'TAB_LOCKED',
    };
  // Connected with Google: the Sheet is one Orderly made, in Orderly's own Google project.
  if (config.auth === 'oauth') {
    // The cached access token ran out early or was refused: the next try asks Google afresh,
    // and a sign-in that really ended is told by Google then (invalid_grant).
    if (response.status === 401) return { message: googleSilent().message, code: 'GOOGLE_DOWN' };
    if (disabled)
      return {
        message: 'Google Sheets isn’t turned on for Orderly. Contact Orderly support.',
        code: 'GOOGLE_REFUSED',
      };
    if (response.status === 403 || response.status === 404)
      return {
        message:
          'Orderly can no longer open your Sheet: it was deleted, or Google no longer lets Orderly use it. Click Reconnect Google in Integrations → Google Sheets to make a new one.',
        code: GOOGLE_REAUTH,
      };
    return {
      message: 'Google Sheets request failed. Orderly will try again.',
      code: 'GOOGLE_REFUSED',
    };
  }
  // Connected with a key file: the owner's own Google Cloud project, and their own share.
  const email = config.clientEmail?.trim();
  if (disabled) {
    const project = projectOfHelper(email);
    return {
      message: `The Google Sheets API is turned off in ${project ? `your Google Cloud project “${project}”` : 'the Google Cloud project that made this key'}. ${SEE_FIX}`,
      code: 'SHEETS_API_OFF',
    };
  }
  if (response.status === 403)
    return {
      message: email
        ? `Share the spreadsheet with the service account ${email} as Editor.`
        : 'Share the spreadsheet with the service account as Editor.',
      code: writing ? 'SHEET_VIEW_ONLY' : 'SHEET_NOT_SHARED',
    };
  if (response.status === 404)
    return {
      message: 'Google found no spreadsheet at this link. Copy the link of your Sheet again.',
      code: 'SHEET_NOT_FOUND',
    };
  // An .xlsx file opened in Google Sheets: the Sheets API only works on Google Sheets files.
  if (response.status === 400 && /not supported for this document/i.test(message))
    return {
      message:
        'This is an Excel file, not a Google Sheet. Open it in Google Sheets, choose File → Save as Google Sheets, and connect the new Sheet’s link.',
      code: 'SHEET_IS_EXCEL',
    };
  return {
    message: 'Google Sheets request failed. Verify the spreadsheet and tab names.',
    code: 'GOOGLE_REFUSED',
  };
}

// How long a new key is given to start working before Google's refusal means it is really dead:
// Google says a new key can need a minute or more.
const NEW_KEY_MS = 5 * 60_000;
/** Why Google refused the key file, which Google says in the body of its token answer. */
function keyRefusal(
  status: number,
  answer: { error?: unknown; error_description?: unknown },
  keySavedAt?: string,
): PublicError {
  const kind = String(answer.error ?? '');
  const text = `${kind} ${String(answer.error_description ?? '')}`;
  if (status >= 500) return googleSilent();
  if (status === 429) return new PublicError(GOOGLE_BUSY_MESSAGE, 503, { code: 'GOOGLE_BUSY' });
  if (/disabled_client|client was disabled/i.test(text))
    return new PublicError(
      `Google shows your key or helper account as switched off. ${SEE_FIX}`,
      502,
      { code: 'HELPER_OFF' },
    );
  if (/deleted_client|invalid_client|account not found/i.test(text))
    return new PublicError(
      `Google can’t find the helper account this key belongs to. ${SEE_FIX}`,
      502,
      { code: 'HELPER_GONE' },
    );
  const saved = keySavedAt ? Date.parse(keySavedAt) : NaN;
  if (Date.now() - saved < NEW_KEY_MS)
    return new PublicError(
      'Google needs about a minute before a new key works. Orderly will check again.',
      503,
      { code: 'KEY_NOT_READY' },
    );
  return new PublicError(
    'Google rejected the service account key. Upload a new key file in Integrations → Google Sheets.',
    502,
    { code: 'KEY_REJECTED' },
  );
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
      throw new PublicError('Upload the Google key file in Integrations → Google Sheets.', 400, {
        code: 'KEY_MISSING',
      });
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
        400,
        { code: 'KEY_BROKEN' },
      );
    }
    const jwt = `${unsigned}.${signature}`;
    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw googleSilent();
    }
    if (!response.ok)
      throw keyRefusal(
        response.status,
        (await response.json().catch(() => ({}))) as { error?: unknown },
        this.integration.config.keySavedAt,
      );
    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }
  private base(): string {
    const id = this.integration.config.spreadsheetId;
    if (!/^[\w-]{15,150}$/.test(id || ''))
      throw new PublicError(
        'Paste your Google Sheet’s link in Integrations → Google Sheets.',
        400,
        {
          code: 'LINK_MISSING',
        },
      );
    return `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  }
  private sheet(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
  }
  private async request(path: string, token: string, init: RequestInit = {}): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw googleSilent();
    }
    if (!response.ok) {
      // A cached Google access token refused: the next try asks Google afresh.
      if (response.status === 401 && this.integration.config.auth === 'oauth')
        forgetGoogleAccessToken(this.credential);
      const writing = !!init.method && init.method !== 'GET';
      const { message, code } = await sheetsRefusal(response, this.integration.config, writing);
      throw new PublicError(message, 502, { code });
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
        400,
        { code: 'ORDERS_TAB_MISSING' },
      );
    const menu = this.integration.config.catalogSheet || 'Menu';
    if (options.menuFor && missing(menu))
      throw new PublicError(
        google
          ? `Your Sheet has no tab named “${menu}”. Add a tab with that name holding your menu, then test again.`
          : `The spreadsheet has no tab named “${menu}”. Add your menu there, or change the menu tab name.`,
        400,
        { code: 'MENU_TAB_MISSING' },
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
        400,
        { code: 'MENU_INVALID' },
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
    try {
      return catalogFromRows(
        companyId,
        rows.map((row) => keep.map((index) => row?.[index] ?? '')),
      );
    } catch (error) {
      // The message names the row and what is wrong; the code opens the fix for the menu.
      if (error instanceof PublicError && !error.code)
        throw new PublicError(error.message, error.status, { code: 'MENU_INVALID' });
      throw error;
    }
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
        400,
        { code: 'ORDERS_TAB_HAS_DATA' },
      );
    }
    if (!values.length) {
      // Column A is empty, but the header row must not write over data in the other columns.
      const first = await this.request(`/values/${encodeURIComponent(`${sheet}!1:1`)}`, token);
      if (((first?.values?.[0] ?? []) as unknown[]).some((cell) => String(cell ?? '').trim())) {
        const name = this.integration.config.ordersSheet || 'Orders';
        throw new PublicError(
          `Your “${name}” tab already has other data in it. The orders tab must be empty or begin with the Order ID header: rename that tab (for example to Old), add a new empty tab named ${name}, then test again.`,
          400,
          { code: 'ORDERS_TAB_HAS_DATA' },
        );
      }
      await this.request(
        `/values/${encodeURIComponent(`${sheet}!A1:M1`)}?valueInputOption=RAW`,
        token,
        { method: 'PUT', body: JSON.stringify({ values: [ORDER_HEADERS] }) },
      );
    }
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
