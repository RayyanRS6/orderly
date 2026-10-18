import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
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
}) {
  const calls: { method: string; url: URL }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 't' });
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
      'Share the spreadsheet with the service account as Editor.',
    );
    google({ values: orders('Customer list') });
    await expect(test()).rejects.toThrow('must be empty or begin with the Order ID header');
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
