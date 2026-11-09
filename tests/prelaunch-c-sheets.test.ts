import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import { catalogFromRows, parsePrice } from '../server/integrations/catalog';
import { seedCompanies } from '../src/shared/seed';
import type { Integration } from '../src/shared/types';

const company = seedCompanies[0];
const spreadsheetId = 'test_spreadsheet_123456789';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const integration = (config: Record<string, string> = {}): Integration => ({
  kind: 'sheets',
  configured: true,
  status: 'configured',
  config: { spreadsheetId, clientEmail: 'menu@example.iam.gserviceaccount.com', ...config },
});
const head = ['id', 'name', 'description', 'category', 'price', 'available'];
const item = (price: unknown, available: unknown = 'true') => [
  'a',
  'Biryani',
  '',
  'Mains',
  price,
  available,
];
beforeEach(() => {
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Google: the token endpoint, spreadsheet metadata, and value reads and writes by range.
function google(options: {
  tabs?: string[];
  values?: Record<string, unknown[][]>;
  writeStatus?: number;
  /** Google's refusal of the first spreadsheet request: its status and error body. */
  refuse?: [number, unknown];
}) {
  const calls: { method: string; url: URL }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 't' });
      if (options.refuse) return Response.json(options.refuse[1], { status: options.refuse[0] });
      if (!url.pathname.includes('/values/'))
        return Response.json({
          spreadsheetId,
          sheets: (options.tabs ?? ['Orders', 'Menu']).map((title) => ({ properties: { title } })),
        });
      if (method !== 'GET')
        return options.writeStatus
          ? Response.json({ error: 'denied' }, { status: options.writeStatus })
          : Response.json({});
      const range = decodeURIComponent(url.pathname.split('/values/')[1]!);
      return Response.json({ values: options.values?.[range] ?? [] });
    }),
  );
  return calls;
}

describe('menu prices typed the way Pakistani owners type them', () => {
  it.each([
    ['1,200', 120000],
    ['Rs 450', 45000],
    ['Rs. 450', 45000],
    ['rs450', 45000],
    ['PKR 1,200.00', 120000],
    ['450/-', 45000],
    ['Rs 1,450/-', 145000],
    ['₨450', 45000],
    ['٤٥٠', 45000],
    ['۴۵۰', 45000],
    ['1,20,000', 12000000],
    ['450.50', 45050],
    [1200, 120000],
    [450.5, 45050],
  ])('reads %s', (price, paisa) => {
    expect(catalogFromRows(company.id, [head, item(price)])[0]!.price).toBe(paisa);
  });

  it.each(['1.200', '12,50', '12,5', '1e3', '0x1F4', '1 200', 'Infinity', '-5', 'free'])(
    'refuses %s rather than guessing, naming the row, column and value',
    (price) => {
      expect(() => catalogFromRows(company.id, [head, item(price)])).toThrow(
        `Row 2, price: “${price}” is not a price. Use a plain number such as 1200. No menu changes were saved.`,
      );
    },
  );

  it('accepts yes/no style availability and names a bad value', () => {
    const rows = [
      head,
      ...['Y', 'n', 'Available', 'unavailable', true, false].map((a, i) => [
        `id-${i}`,
        `Dish ${i}`,
        '',
        'Mains',
        100,
        a,
      ]),
    ];
    expect(catalogFromRows(company.id, rows).map((p) => p.available)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(() => catalogFromRows(company.id, [head, item(100, '✓')])).toThrow(
      'Row 2, available: “✓” must be yes or no (or true or false). No menu changes were saved.',
    );
    expect(() => catalogFromRows(company.id, [head, item('', 'yes')])).toThrow(
      'Row 2, price is empty.',
    );
  });

  it('counts rows as the sheet does and never replaces the menu with nothing', () => {
    expect(() => catalogFromRows(company.id, [head, [], ['', '  '], item('1.200')])).toThrow(
      /^Row 4, price/,
    );
    expect(() => catalogFromRows(company.id, [head, ['  ', '', ' ']])).toThrow(
      'The menu has no items. Add at least one. No menu changes were saved.',
    );
    // A numeric header or id from the Sheet is read as text; id 1 and '1' stay the same item.
    const [fromNumber] = catalogFromRows(company.id, [
      [...head, 2026],
      [1, 'Tea', '', 'Drinks', 50, true, 'x'],
    ]);
    const [fromText] = catalogFromRows(company.id, [
      head,
      ['1', 'Tea', '', 'Drinks', '50', 'true'],
    ]);
    expect(fromNumber!.id).toBe(fromText!.id);
    expect(parsePrice(true)).toBeUndefined();
  });
});

describe('reading the menu tab', () => {
  const full = ['id', 'name', 'description', 'category', 'price', 'available', 'emoji', 'aliases'];
  const options = '[{"id":"l","name":"Large","price":1600}]';
  const extras = '[{"id":"c","name":"Extra cheese","price":150}]';
  const read = (values: unknown[][]) => {
    const calls = google({ values: { "'Menu'!1:502": values } });
    return {
      calls,
      products: new GoogleSheetsAdapter(integration(), pem).readCatalog(company.id),
    };
  };

  it('asks Google for cell values, not their locale display text', async () => {
    const { calls, products } = read([head, item(1200)]);
    expect((await products)[0]!.price).toBe(120000);
    const url = calls.find((c) => c.url.pathname.includes('/values/'))!.url;
    expect(url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
    expect(url.searchParams.get('dateTimeRenderOption')).toBe('FORMATTED_STRING');
  });

  it('finds sizes and add-ons by their header, wherever the columns are', async () => {
    const inserted = await read([
      [...full, 'notes', 'urdu name', 'variants', 'modifiers'],
      ['p', 'Pizza', '', 'Mains', 800, true, '', '', 'x', 'y', options, extras],
    ]).products;
    expect(inserted[0]).toMatchObject({
      price: 80000,
      variants: [{ id: 'l', name: 'Large', price: 160000 }],
      modifiers: [{ id: 'c', name: 'Extra cheese', price: 15000 }],
    });
    const atStart = await read([
      ['s.no', ...full, 'variants', 'modifiers'],
      [1, 'p', 'Pizza', '', 'Mains', 800, true, '', '', options, extras],
    ]).products;
    expect(atStart[0]!.modifiers).toHaveLength(1);
    // A later repeat of a header is ignored: the first price column is the price.
    const repeated = await read([
      [...full, 'price'],
      ['p', 'Pizza', '', 'Mains', 800, true, '', '', 999],
    ]).products;
    expect(repeated[0]!.price).toBe(80000);
  });

  it('fails loudly instead of dropping a bad option list placed after column J', async () => {
    await expect(
      read([
        [...full, 'a', 'b', 'c', 'modifiers'],
        ['p', 'Pizza', '', 'Mains', 800, true, '', '', '', '', '', 'not json'],
      ]).products,
    ).rejects.toThrow('Row 2, modifiers: the option list is not valid JSON.');
  });
});

describe('the Sheets connection test', () => {
  const test = (config: Record<string, string> = {}, menuFor?: string) =>
    new GoogleSheetsAdapter(integration(config), pem).test(menuFor ? { menuFor } : {});
  const orders = (first: string) => ({ "'Orders'!A:A": [[first]] });

  it('finds the tabs whatever their case and proves it can write', async () => {
    const calls = google({ tabs: ['orders', 'MENU'], values: orders('Order ID') });
    await expect(test()).resolves.toBeUndefined();
    const write = calls.find((c) => c.method === 'PUT')!;
    expect(decodeURIComponent(write.url.pathname)).toContain("'Orders'!A1");
    expect(write.url.searchParams.get('valueInputOption')).toBe('RAW');
  });

  it('writes the header row into an empty orders tab', async () => {
    const calls = google({});
    await test();
    expect(decodeURIComponent(calls.find((c) => c.method === 'PUT')!.url.pathname)).toContain(
      "'Orders'!A1:M1",
    );
  });

  it('refuses a missing tab, Viewer access and an orders tab holding other data', async () => {
    google({ tabs: ['Sheet1'] });
    await expect(test()).rejects.toThrow('The spreadsheet has no tab named “Orders”.');
    google({ tabs: ['Sales'] });
    await expect(test({ ordersSheet: 'Sales' }, company.id)).rejects.toThrow(
      'The spreadsheet has no tab named “Menu”.',
    );
    google({ values: orders('Order ID'), writeStatus: 403 });
    await expect(test()).rejects.toThrow(
      'Share the spreadsheet with the service account menu@example.iam.gserviceaccount.com as Editor.',
    );
    google({ values: orders('Customer list') });
    await expect(test()).rejects.toThrow('must be empty or begin with the Order ID header');
    await expect(test()).rejects.toThrow('add a new empty tab named Orders');
  });

  it('names the fix when Google refuses the spreadsheet', async () => {
    // Google's error body: { error: { code, message, status, details } }.
    const error = (
      code: number,
      status: string,
      message: string,
      reason?: string,
    ): [number, unknown] => [
      code,
      {
        error: {
          code,
          message,
          status,
          ...(reason && {
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
          }),
        },
      },
    ];
    google({
      refuse: error(
        403,
        'PERMISSION_DENIED',
        'Google Sheets API has not been used in project 123 before or it is disabled.',
        'SERVICE_DISABLED',
      ),
    });
    await expect(test()).rejects.toThrow(
      'The Google Sheets API is turned off in your Google Cloud project “example”.',
    );
    google({ refuse: error(403, 'PERMISSION_DENIED', 'The caller does not have permission') });
    await expect(test()).rejects.toThrow(
      'Share the spreadsheet with the service account menu@example.iam.gserviceaccount.com as Editor.',
    );
    google({ refuse: error(404, 'NOT_FOUND', 'Requested entity was not found.') });
    await expect(test()).rejects.toThrow('Google found no spreadsheet at this link.');
    google({
      refuse: error(
        400,
        'FAILED_PRECONDITION',
        'This operation is not supported for this document',
      ),
    });
    await expect(test()).rejects.toThrow('This is an Excel file, not a Google Sheet.');
    // A refusal without a JSON body still gets the general message.
    google({ refuse: [400, 'oops'] });
    await expect(test()).rejects.toMatchObject({
      code: 'GOOGLE_REFUSED',
      message: expect.stringContaining('Google Sheets request failed.'),
    });
  });

  it('gives every refusal the code that opens its guided fix', async () => {
    const error = (code: number, message: string, reason?: string): [number, unknown] => [
      code,
      { error: { code, message, ...(reason && { details: [{ reason }] }) } },
    ];
    const cases: [[number, unknown], string][] = [
      [error(403, 'disabled', 'SERVICE_DISABLED'), 'SHEETS_API_OFF'],
      [error(403, 'The caller does not have permission'), 'SHEET_NOT_SHARED'],
      [error(404, 'Requested entity was not found.'), 'SHEET_NOT_FOUND'],
      [error(400, 'This operation is not supported for this document'), 'SHEET_IS_EXCEL'],
      [error(429, 'Too many'), 'GOOGLE_BUSY'],
      [error(503, 'Unavailable'), 'GOOGLE_DOWN'],
      [error(400, 'You are trying to edit a protected cell or object'), 'TAB_LOCKED'],
    ];
    for (const [refuse, code] of cases) {
      google({ refuse });
      await expect(test()).rejects.toMatchObject({ code });
    }
    // A tab name with an apostrophe comes back quoted, the apostrophe doubled.
    google({ refuse: error(400, "Unable to parse range: 'Joe''s Menu'!1:502") });
    await expect(test({ catalogSheet: "Joe's Menu" })).rejects.toMatchObject({
      code: 'MENU_TAB_MISSING',
      message: expect.stringContaining('Click Test on the Google Sheets card'),
    });
    google({ refuse: error(400, 'Unable to parse range: Orders!A:A') });
    await expect(test()).rejects.toMatchObject({ code: 'ORDERS_TAB_MISSING' });
    google({ values: orders('Order ID'), writeStatus: 403 });
    await expect(test()).rejects.toMatchObject({ code: 'SHEET_VIEW_ONLY' });
    google({ tabs: ['Sheet1'] });
    await expect(test()).rejects.toMatchObject({ code: 'ORDERS_TAB_MISSING' });
    google({ tabs: ['Orders'] });
    await expect(test({}, company.id)).rejects.toMatchObject({ code: 'MENU_TAB_MISSING' });
    google({ values: orders('Customer list') });
    await expect(test()).rejects.toMatchObject({ code: 'ORDERS_TAB_HAS_DATA' });
    google({ values: { ...orders('Order ID'), "'Menu'!1:502": [head, item('abc')] } });
    await expect(test({}, company.id)).rejects.toMatchObject({ code: 'MENU_INVALID' });
    await expect(
      new GoogleSheetsAdapter(integration({ spreadsheetId: '' }), pem).test(),
    ).rejects.toMatchObject({ code: 'LINK_MISSING' });
    await expect(
      new GoogleSheetsAdapter(integration({ clientEmail: '' }), pem).test(),
    ).rejects.toMatchObject({ code: 'KEY_MISSING' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await expect(test()).rejects.toMatchObject({ code: 'GOOGLE_DOWN' });
  });

  it('says why Google refused the key, and gives a new key time to work', async () => {
    const token = (status: number, body: unknown) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body, { status })),
      );
    const signature = { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' };
    token(400, signature);
    await expect(test()).rejects.toMatchObject({ code: 'KEY_REJECTED' });
    await expect(
      test({ keySavedAt: new Date(Date.now() - 60_000).toISOString() }),
    ).rejects.toMatchObject({ code: 'KEY_NOT_READY' });
    await expect(
      test({ keySavedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
    ).rejects.toMatchObject({ code: 'KEY_REJECTED' });
    token(400, { error: 'disabled_client', error_description: 'The OAuth client was disabled.' });
    await expect(test()).rejects.toMatchObject({ code: 'HELPER_OFF' });
    token(400, { error: 'invalid_grant', error_description: 'Invalid grant: account not found' });
    await expect(test()).rejects.toMatchObject({ code: 'HELPER_GONE' });
    token(500, {});
    await expect(test()).rejects.toMatchObject({ code: 'GOOGLE_DOWN' });
    await expect(
      new GoogleSheetsAdapter(integration(), '-----BEGIN PRIVATE KEY-----\ncut off').test(),
    ).rejects.toMatchObject({ code: 'KEY_BROKEN' });
  });

  it('never writes its titles over other data in an empty first column', async () => {
    const calls = google({ values: { "'Orders'!1:1": [['', 'Customer', 'Phone']] } });
    await expect(test()).rejects.toMatchObject({ code: 'ORDERS_TAB_HAS_DATA' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('leaves the connection as it is when Google is only busy, and records a real problem', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, integration({}), encryptSecret(pem));
    const run = () =>
      createApp(repo).request('http://127.0.0.1:4000/api/integrations/sheets/test', {
        method: 'POST',
        headers: { 'x-company-id': company.id, Origin: 'http://127.0.0.1:5173' },
      });
    const saved = async () =>
      (await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets');
    google({ refuse: [503, { error: { code: 503 } }] });
    const busy = await run();
    expect((await busy.json()).code).toBe('GOOGLE_DOWN');
    expect((await saved())?.status).toBe('configured');
    google({
      refuse: [
        403,
        { error: { code: 403, message: 'x', details: [{ reason: 'SERVICE_DISABLED' }] } },
      ],
    });
    const off = await run();
    expect((await off.json()).code).toBe('SHEETS_API_OFF');
    expect(await saved()).toMatchObject({ status: 'error', errorCode: 'SHEETS_API_OFF' });
    google({ values: orders('Order ID') });
    expect((await run()).status).toBe(200);
    const fixed = await saved();
    expect(fixed?.status).toBe('connected');
    expect(fixed?.errorCode).toBeUndefined();
    expect(fixed?.error).toBeUndefined();
  });

  it('stamps when a key was saved, so a new key gets its minute', async () => {
    const repo = new MemoryRepository();
    const response = await createApp(repo).request(
      'http://127.0.0.1:4000/api/integrations/sheets',
      {
        method: 'POST',
        headers: {
          'x-company-id': company.id,
          Origin: 'http://127.0.0.1:5173',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: { spreadsheetId, clientEmail: 'menu@example.iam.gserviceaccount.com' },
          secret: pem,
        }),
      },
    );
    expect(response.status).toBe(200);
    const saved = (await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets');
    expect(Date.now() - Date.parse(saved!.config.keySavedAt!)).toBeLessThan(60_000);
  });

  it('shows a background copy’s problem on the card, and clears it when copies work again', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, integration(), encryptSecret(pem));
    const saved = async () =>
      (await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const order = (await repo.listOrders(company.id))[0]!;
    const conversation = (await repo.getConversation(order.companyId, order.conversationId))!;
    await repo.saveConversation({ ...conversation, channel: 'whatsapp' });
    await repo.saveOrder({ ...order, sandbox: false });
    const copy = async () => {
      const job = makeJob(company.id, 'sheet_sync', { orderId: order.id });
      await repo.insertJob(job);
      await processJob(repo, job.id).catch(() => undefined);
    };
    google({
      refuse: [403, { error: { code: 403, message: 'The caller does not have permission' } }],
    });
    await copy();
    expect(await saved()).toMatchObject({
      status: 'configured',
      errorCode: 'SHEET_NOT_SHARED',
      error: expect.stringContaining('Share the spreadsheet'),
    });
    google({ values: orders('Order ID') });
    await copy();
    const after = await saved();
    expect(after?.errorCode).toBeUndefined();
    expect(after?.error).toBeUndefined();
    // A problem a failed Test found stays until Test passes: Test checks more than a copy does.
    await repo.saveIntegration(company.id, {
      ...after!,
      status: 'error',
      error: 'Your Sheet has no tab named “Menu”.',
      errorCode: 'MENU_TAB_MISSING',
    });
    await copy();
    expect(await saved()).toMatchObject({ status: 'error', errorCode: 'MENU_TAB_MISSING' });
  });

  it('refuses a business that uses the same Sheet, with the code that explains it', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, integration(), encryptSecret(pem));
    await expect(
      repo.saveIntegration(seedCompanies[1].id, integration(), encryptSecret(pem)),
    ).rejects.toMatchObject({ code: 'SHEET_TAKEN' });
  });

  it('says so when the saved private key is not a key, before calling Google', async () => {
    const calls = google({});
    await expect(
      new GoogleSheetsAdapter(integration(), '-----BEGIN PRIVATE KEY-----\ncut off').test(),
    ).rejects.toThrow('The saved private key is not a valid Google key.');
    expect(calls).toHaveLength(0);
  });

  it('checks the menu tab when the menu comes from the Sheet', async () => {
    google({ values: { ...orders('Order ID'), "'Menu'!1:502": [head, item('1.200')] } });
    await expect(test({}, company.id)).rejects.toThrow('Row 2, price: “1.200” is not a price.');
    google({ values: { ...orders('Order ID'), "'Menu'!1:502": [head, item(450, 'no')] } });
    await expect(test({}, company.id)).rejects.toThrow('The menu tab has no available items.');
    google({ values: { ...orders('Order ID'), "'Menu'!1:502": [head, item(450)] } });
    await expect(test({}, company.id)).resolves.toBeUndefined();
  });

  it('marks the connection as failing in the dashboard when a check fails', async () => {
    const repo = new MemoryRepository();
    await repo.saveCompany({ ...company, catalogSource: 'sheets' });
    await repo.saveIntegration(company.id, integration(), encryptSecret(pem));
    google({ values: orders('Order ID') });
    const response = await createApp(repo).request(
      'http://127.0.0.1:4000/api/integrations/sheets/test',
      {
        method: 'POST',
        headers: { 'x-company-id': company.id, Origin: 'http://127.0.0.1:5173' },
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Add a header row and at least one menu item.');
    expect((await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets')).toMatchObject(
      { status: 'error' },
    );
  });
});
