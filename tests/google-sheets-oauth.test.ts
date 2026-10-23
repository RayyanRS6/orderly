// "Connect with Google" for the order Sheet: the popup's code becomes a stored Google sign-in,
// Orderly makes the Sheet in the owner's Drive, and Google's access is ended only when no other
// business still uses that Google account. Google itself is a fake here; nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { decryptSecret, encryptSecret, logFailure, PublicError } from '../server/security';
import { connectGoogleSheets } from '../server/integrations/google-sheets-connect';
import { DRIVE_FILE_SCOPE, GOOGLE_REAUTH } from '../server/integrations/google-oauth';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import { catalogFromRows, catalogRows } from '../server/integrations/catalog';
import { processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import { seedCompanies } from '../src/shared/seed';
import type { Integration } from '../src/shared/types';

const company = seedCompanies[0];
const other = seedCompanies[1];
const origin = 'http://127.0.0.1:5173';

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('APP_URL', origin);
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GOOGLE_SHEETS_CONNECT', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let unique = 0;
/** A refresh token no earlier test used, so cached access tokens never leak between tests. */
const token = (label: string) => `1//${label}-${++unique}-abcdefghijklmnopqrstuvwxyz`;

interface Call {
  method: string;
  url: URL;
  body?: Record<string, unknown>;
}
/**
 * Google: the token endpoint (code and refresh), revoke, Drive's about, and Sheets (create,
 * open, the connection test's reads and writes).
 */
function fakeGoogle(
  options: {
    account?: string;
    email?: string;
    /** The refresh token a code exchange gives; null gives none (a repeat consent). */
    refreshToken?: string | null;
    scope?: string;
    deadTokens?: string[];
    /** Stored tokens Google doesn't answer for (a 500), which may still work. */
    unanswered?: string[];
    /** Whether a Sheet made before still opens. */
    opens?: boolean;
    /** Google refuses to create the Sheet. */
    createFails?: boolean;
    /** The tabs the Sheet has; a tab added through batchUpdate joins them. */
    tabs?: string[];
  } = {},
) {
  const calls: Call[] = [];
  const revoked: string[] = [];
  const tabs = [...(options.tabs ?? ['Orders', 'Menu'])];
  let created = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body =
        init?.body instanceof URLSearchParams
          ? Object.fromEntries(init.body)
          : init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : undefined;
      calls.push({ method, url, body });
      if (url.href === 'https://oauth2.googleapis.com/token') {
        if (body?.grant_type === 'authorization_code')
          return Response.json({
            access_token: 'ya29.from-code',
            ...(options.refreshToken !== null && {
              refresh_token: options.refreshToken ?? 'unused',
            }),
            scope: options.scope ?? DRIVE_FILE_SCOPE,
            expires_in: 3599,
          });
        if (options.deadTokens?.includes(String(body?.refresh_token)))
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        if (options.unanswered?.includes(String(body?.refresh_token)))
          return Response.json({ error: 'internal_failure' }, { status: 500 });
        return Response.json({ access_token: `ya29.${body?.refresh_token}`, expires_in: 3599 });
      }
      if (url.href === 'https://oauth2.googleapis.com/revoke') {
        revoked.push(String(body?.token));
        return new Response('', { status: 200 });
      }
      if (url.hostname === 'www.googleapis.com')
        return Response.json({
          user: {
            permissionId: options.account ?? 'account-1',
            emailAddress: options.email ?? 'owner@example.com',
          },
        });
      if (url.hostname === 'sheets.googleapis.com') {
        if (method === 'POST' && url.pathname === '/v4/spreadsheets')
          return options.createFails
            ? Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 })
            : Response.json({ spreadsheetId: `made_by_orderly_${++created}_abcdefgh` });
        if (method === 'POST' && url.pathname.endsWith(':batchUpdate')) {
          const requests = (body?.requests ?? []) as {
            addSheet?: { properties: { title: string } };
          }[];
          for (const r of requests) if (r.addSheet) tabs.push(r.addSheet.properties.title);
          return Response.json({});
        }
        const fields = url.searchParams.get('fields') ?? '';
        if (fields === 'spreadsheetId')
          return options.opens === false
            ? Response.json({ error: { code: 404 } }, { status: 404 })
            : Response.json({ spreadsheetId: 'x' });
        if (fields.startsWith('spreadsheetId,sheets') || fields === 'sheets.properties.title')
          return Response.json({ sheets: tabs.map((title) => ({ properties: { title } })) });
        if (url.pathname.includes('/values/')) {
          if (method !== 'GET') return Response.json({});
          const range = decodeURIComponent(url.pathname.split('/values/')[1]!);
          return Response.json({
            values: range.startsWith("'Menu'")
              ? [
                  ['name', 'category', 'price', 'available'],
                  ['Biryani', 'Mains', 450, 'yes'],
                ]
              : [['Order ID']],
          });
        }
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  const created_ = () =>
    calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v4/spreadsheets');
  return { calls, revoked, creates: created_ };
}

const sheets = async (repo: MemoryRepository, companyId = company.id) =>
  (await repo.getIntegrations(companyId)).find((i) => i.kind === 'sheets');
const storedToken = async (repo: MemoryRepository, companyId = company.id) =>
  decryptSecret((await repo.getSecret(companyId, 'sheets'))!);
const googleRow = (account: string, spreadsheetId = 'made_before_123456789'): Integration => ({
  kind: 'sheets',
  configured: true,
  status: 'connected',
  config: {
    auth: 'oauth',
    spreadsheetId,
    ordersSheet: 'Orders',
    catalogSheet: 'Menu',
    googleAccountId: account,
  },
});

describe('connecting with Google', () => {
  it('makes the Sheet in the owner’s Drive and stores the sign-in encrypted', async () => {
    const repo = new MemoryRepository();
    const refresh = token('first');
    const google = fakeGoogle({ refreshToken: refresh, email: 'owner@example.com' });
    const result = await connectGoogleSheets(repo, company, 'code-from-popup');
    expect(result).toMatchObject({ created: true, title: `Orderly – ${company.name} orders` });
    const saved = await sheets(repo);
    expect(saved).toMatchObject({
      status: 'connected',
      configured: true,
      config: {
        auth: 'oauth',
        spreadsheetId: 'made_by_orderly_1_abcdefgh',
        ordersSheet: 'Orders',
        googleAccountId: 'account-1',
        googleEmail: 'owner@example.com',
      },
    });
    // The sign-in is the secret, never part of the settings the dashboard reads.
    expect(JSON.stringify(saved)).not.toContain(refresh);
    expect(await storedToken(repo)).toBe(refresh);
    const [create] = google.creates();
    const tabs = create.body!.sheets as {
      properties: { title: string; gridProperties: { frozenRowCount: number } };
      data: { rowData: { values: { userEnteredValue: { stringValue: string } }[] }[] }[];
    }[];
    expect(tabs.map((t) => t.properties.title)).toEqual(['Orders']);
    expect(tabs[0].properties.gridProperties.frozenRowCount).toBe(1);
    expect(tabs[0].data[0].rowData[0].values.map((v) => v.userEnteredValue.stringValue)).toContain(
      'Order ID',
    );
    // The code is redeemed as Google's popup flow expects.
    const exchange = google.calls.find((c) => c.body?.grant_type === 'authorization_code')!;
    expect(exchange.body).toMatchObject({ code: 'code-from-popup', redirect_uri: 'postmessage' });
    expect(google.revoked).toEqual([]);
  });

  it('puts the current menu in a Menu tab when the menu is read from the Sheet', async () => {
    const repo = new MemoryRepository();
    const google = fakeGoogle({ refreshToken: token('menu') });
    await connectGoogleSheets(repo, { ...company, catalogSource: 'sheets' }, 'code-1234567');
    const tabs = google.creates()[0].body!.sheets as { properties: { title: string } }[];
    expect(tabs.map((t) => t.properties.title)).toEqual(['Orders', 'Menu']);
  });

  it('writes a menu as rows that read back as the same menu', async () => {
    const repo = new MemoryRepository();
    const products = (await repo.listProducts(company.id)).filter((p) => !p.deal);
    const rows = catalogRows(products);
    expect(rows[0]).toContain('image');
    expect(catalogFromRows(company.id, rows)).toEqual(
      products.map((p) => ({ ...p, imageUrl: p.imageUrl })),
    );
  });

  it('refuses a sign-in without the permission to make the Sheet', async () => {
    const repo = new MemoryRepository();
    fakeGoogle({ refreshToken: token('scope'), scope: 'openid email' });
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toThrow(
      'Google didn’t give Orderly permission to make your Sheet.',
    );
    expect(await sheets(repo)).toBeUndefined();
  });

  it('asks once more when Google gives no lasting access and no business keeps one', async () => {
    const repo = new MemoryRepository();
    const google = fakeGoogle({ refreshToken: null });
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toThrow(
      'Click Connect with Google once more.',
    );
    // Ending this sign-in makes Google show its consent, with a lasting token, next time.
    expect(google.revoked).toEqual(['ya29.from-code']);
    expect(await sheets(repo)).toBeUndefined();
  });

  it('reuses the sign-in another business keeps for the same Google account', async () => {
    const repo = new MemoryRepository();
    const shared = token('shared');
    await repo.saveIntegration(other.id, googleRow('account-1'), encryptSecret(shared));
    const google = fakeGoogle({ refreshToken: null });
    const result = await connectGoogleSheets(repo, company, 'code-1234567');
    expect(result.created).toBe(true);
    expect(await storedToken(repo)).toBe(shared);
    expect(google.revoked).toEqual([]);
  });

  it('skips a stored sign-in Google has ended', async () => {
    const repo = new MemoryRepository();
    const dead = token('dead');
    await repo.saveIntegration(other.id, googleRow('account-1'), encryptSecret(dead));
    const google = fakeGoogle({ refreshToken: null, deadTokens: [dead] });
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toThrow('once more');
    expect(google.revoked).toEqual(['ya29.from-code']);
  });

  it('never ends anyone’s access when Google doesn’t answer for a stored sign-in', async () => {
    const repo = new MemoryRepository();
    const shared = token('unanswered');
    await repo.saveIntegration(
      other.id,
      googleRow('account-1', 'other_business_sheet_1234'),
      encryptSecret(shared),
    );
    const google = fakeGoogle({ refreshToken: null, unanswered: [shared] });
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('Try again in a minute'),
    });
    // Ending this sign-in would end the other business's working one too.
    expect(google.revoked).toEqual([]);
    expect(await sheets(repo)).toBeUndefined();
  });

  it('gives back a fresh sign-in when the Sheet can’t be made, unless another business uses it', async () => {
    const repo = new MemoryRepository();
    const fresh = token('fresh');
    let google = fakeGoogle({ refreshToken: fresh, createFails: true });
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toThrow(
      'create your Sheet',
    );
    expect(google.revoked).toEqual([fresh]);
    await repo.saveIntegration(
      other.id,
      googleRow('account-1', 'other_business_sheet_1234'),
      encryptSecret(token('kept')),
    );
    google = fakeGoogle({ refreshToken: token('fresh-again'), createFails: true });
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toThrow();
    expect(google.revoked).toEqual([]);
  });

  it('keeps the Sheet it made before when it still opens, and makes a new one when not', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, googleRow('account-1'), encryptSecret(token('old')));
    let google = fakeGoogle({ refreshToken: token('again'), opens: true });
    expect(await connectGoogleSheets(repo, company, 'code-1234567')).toMatchObject({
      created: false,
    });
    expect((await sheets(repo))?.config.spreadsheetId).toBe('made_before_123456789');
    expect(google.creates()).toHaveLength(0);
    google = fakeGoogle({ refreshToken: token('again'), opens: false });
    expect(await connectGoogleSheets(repo, company, 'code-1234567')).toMatchObject({
      created: true,
    });
    expect((await sheets(repo))?.config.spreadsheetId).toBe('made_by_orderly_1_abcdefgh');
  });

  it('ends the replaced Google account’s access only when no other business uses it', async () => {
    const repo = new MemoryRepository();
    const old = token('old-account');
    await repo.saveIntegration(company.id, googleRow('old-account'), encryptSecret(old));
    let google = fakeGoogle({ refreshToken: token('new'), account: 'new-account' });
    await connectGoogleSheets(repo, company, 'code-1234567');
    expect(google.revoked).toEqual([old]);
    // The same switch while another business still uses the old account ends nothing.
    const kept = token('old-shared');
    await repo.saveIntegration(company.id, googleRow('old-shared'), encryptSecret(kept));
    await repo.saveIntegration(
      other.id,
      googleRow('old-shared', 'other_business_sheet_1234'),
      encryptSecret(kept),
    );
    google = fakeGoogle({ refreshToken: token('new'), account: 'new-account' });
    await connectGoogleSheets(repo, company, 'code-1234567');
    expect(google.revoked).toEqual([]);
  });

  it('saves the connection with the failed check when the Sheet test fails', async () => {
    const repo = new MemoryRepository();
    fakeGoogle({ refreshToken: token('test') });
    vi.spyOn(GoogleSheetsAdapter.prototype, 'test').mockRejectedValue(
      new PublicError('The spreadsheet has no tab named “Orders”.'),
    );
    await expect(connectGoogleSheets(repo, company, 'code-1234567')).rejects.toThrow(
      'no tab named',
    );
    expect(await sheets(repo)).toMatchObject({ status: 'error', error: expect.any(String) });
  });
});

describe('a Sheet connected with Google, afterwards', () => {
  it('asks Google for an access token once, then reuses it', async () => {
    const google = fakeGoogle();
    const adapter = new GoogleSheetsAdapter(googleRow('a'), token('cache'));
    await adapter.test();
    await adapter.test();
    expect(google.calls.filter((c) => c.body?.grant_type === 'refresh_token')).toHaveLength(1);
  });

  it('says to reconnect when Google has ended the sign-in, or the Sheet is gone', async () => {
    const dead = token('ended');
    fakeGoogle({ deadTokens: [dead] });
    const ended = new GoogleSheetsAdapter(googleRow('a'), dead).test();
    await expect(ended).rejects.toMatchObject({ code: GOOGLE_REAUTH });
    await expect(ended).rejects.toThrow('Click Reconnect Google');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) =>
        String(input).startsWith('https://oauth2')
          ? Response.json({ access_token: 'ya29.x', expires_in: 3599 })
          : Response.json({ error: { code: 404 } }, { status: 404 }),
      ),
    );
    await expect(
      new GoogleSheetsAdapter(googleRow('a'), token('gone')).test(),
    ).rejects.toMatchObject({ code: GOOGLE_REAUTH, message: expect.stringContaining('deleted') });
  });

  it('names the tab when the owner renamed it, and asks Google afresh after a 401', async () => {
    let refreshes = 0;
    const credential = token('renamed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.hostname === 'oauth2.googleapis.com') {
          refreshes++;
          return Response.json({ access_token: `ya29.${refreshes}`, expires_in: 3599 });
        }
        if (url.pathname.includes('/values/'))
          return Response.json(
            { error: { code: 400, message: "Unable to parse range: 'Orders'!A:A" } },
            { status: 400 },
          );
        return Response.json({ error: { code: 401 } }, { status: 401 });
      }),
    );
    const adapter = new GoogleSheetsAdapter(googleRow('a'), credential);
    await expect(adapter.readCatalog(company.id)).rejects.toThrow(
      'Rename the tab back to “Orders” (or “Menu”)',
    );
    // The token is cached until Google refuses it (401); then the next call asks for a new one.
    await expect(adapter.test()).rejects.toThrow();
    expect(refreshes).toBe(1);
    await expect(adapter.test()).rejects.toThrow();
    expect(refreshes).toBe(2);
  });

  it('shows the reconnect message on the card when an order copy finds the sign-in ended', async () => {
    const repo = new MemoryRepository();
    const dead = token('job');
    await repo.saveIntegration(company.id, googleRow('a'), encryptSecret(dead));
    fakeGoogle({ deadTokens: [dead] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order = (await repo.listOrders(company.id))[0];
    const conversation = (await repo.getConversation(order.companyId, order.conversationId))!;
    await repo.saveConversation({ ...conversation, channel: 'whatsapp' });
    await repo.saveOrder({ ...order, sandbox: false });
    const job = makeJob(company.id, 'sheet_sync', { orderId: order.id });
    await repo.insertJob(job);
    await processJob(repo, job.id).catch(() => undefined);
    // Only the note changes: a failing background copy must not block saving settings.
    expect(await sheets(repo)).toMatchObject({
      status: 'connected',
      error: expect.stringContaining('Reconnect Google'),
    });
  });

  it('keeps Google tokens out of the log', () => {
    const log = vi.mocked(console.error);
    logFailure('test', {}, new Error('bad ya29.a0AfB_secret and 1//0gAbCdEfGhIjKlMnOpQrStUv'));
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).not.toContain('ya29.a0AfB_secret');
    expect(line).not.toContain('1//0gAbCdEfGhIjKlMnOpQrStUv');
  });
});

describe('the Google routes', () => {
  const request = (repo: MemoryRepository, path: string, method = 'GET', body?: unknown) =>
    createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
      method,
      headers: {
        'x-company-id': company.id,
        Origin: origin,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  it('offers the button only when the OAuth client is set and not switched off', async () => {
    const repo = new MemoryRepository();
    expect(await (await request(repo, '/google/sheets-config')).json()).toEqual({
      enabled: true,
      clientId: 'client-id.apps.googleusercontent.com',
    });
    vi.stubEnv('GOOGLE_SHEETS_CONNECT', 'off');
    expect(await (await request(repo, '/google/sheets-config')).json()).toEqual({
      enabled: false,
      clientId: '',
    });
    const refused = await request(repo, '/google/sheets/connect', 'POST', { code: 'code-1234567' });
    expect(refused.status).toBe(409);
    vi.stubEnv('GOOGLE_SHEETS_CONNECT', '');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
    expect((await (await request(repo, '/google/sheets-config')).json()).enabled).toBe(false);
  });

  it('connects through the route', async () => {
    const repo = new MemoryRepository();
    fakeGoogle({ refreshToken: token('route') });
    const response = await request(repo, '/google/sheets/connect', 'POST', {
      code: 'code-1234567',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: true });
    expect((await sheets(repo))?.status).toBe('connected');
  });

  it('ends Google’s access on disconnect, unless another business uses the account', async () => {
    const repo = new MemoryRepository();
    const alone = token('alone');
    await repo.saveIntegration(company.id, googleRow('acct'), encryptSecret(alone));
    let google = fakeGoogle();
    let response = await request(repo, '/integrations/sheets', 'DELETE');
    expect(await response.json()).toMatchObject({ ok: true, providerRevocationRequired: false });
    expect(google.revoked).toEqual([alone]);
    const shared = token('shared-disconnect');
    await repo.saveIntegration(company.id, googleRow('acct'), encryptSecret(shared));
    await repo.saveIntegration(
      other.id,
      googleRow('acct', 'other_business_sheet_1234'),
      encryptSecret(shared),
    );
    google = fakeGoogle();
    response = await request(repo, '/integrations/sheets', 'DELETE');
    expect(await response.json()).toMatchObject({ providerRevocationRequired: false });
    expect(google.revoked).toEqual([]);
    expect(await sheets(repo, other.id)).toBeDefined();
  });

  it('adds a Menu tab with the current menu before the menu is read from a Google Sheet', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, googleRow('acct'), encryptSecret(token('switch')));
    const google = fakeGoogle({ tabs: ['Orders'] });
    const copy = (await (await request(repo, '/bootstrap')).json()).company;
    const response = await request(repo, `/companies/${company.id}`, 'PUT', {
      ...copy,
      catalogSource: 'sheets',
    });
    expect(response.status).toBe(200);
    expect(google.calls.find((c) => c.url.pathname.endsWith(':batchUpdate'))?.body).toMatchObject({
      requests: [{ addSheet: { properties: { title: 'Menu' } } }],
    });
    const written = google.calls.find(
      (c) => c.method === 'PUT' && decodeURIComponent(c.url.pathname).includes("'Menu'!A1"),
    );
    expect((written?.body?.values as unknown[][])[0]).toContain('price');
    expect((await repo.getCompany(company.id))?.catalogSource).toBe('sheets');
  });

  it('refuses to read the menu from a key-file Sheet that has no menu', async () => {
    const repo = new MemoryRepository();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await repo.saveIntegration(
      company.id,
      {
        kind: 'sheets',
        configured: true,
        status: 'connected',
        config: {
          spreadsheetId: 'owners_own_sheet_123456',
          clientEmail: 'sa@p.iam.gserviceaccount.com',
        },
      },
      encryptSecret(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    );
    fakeGoogle({ tabs: ['Orders'] });
    const copy = (await (await request(repo, '/bootstrap')).json()).company;
    const response = await request(repo, `/companies/${company.id}`, 'PUT', {
      ...copy,
      catalogSource: 'sheets',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('no tab named “Menu”');
    expect((await repo.getCompany(company.id))?.catalogSource).toBe('app');
  });

  it('switches a Google connection to a key file only with the key file', async () => {
    const repo = new MemoryRepository();
    const signIn = token('switch');
    await repo.saveIntegration(
      company.id,
      { ...googleRow('acct'), config: { ...googleRow('acct').config, googleEmail: 'o@x.com' } },
      encryptSecret(signIn),
    );
    const google = fakeGoogle();
    const config = {
      spreadsheetId: 'owners_own_sheet_123456',
      clientEmail: 'sa@p.iam.gserviceaccount.com',
    };
    const refused = await request(repo, '/integrations/sheets', 'POST', { config });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain('connected with Google');
    const switched = await request(repo, '/integrations/sheets', 'POST', {
      config,
      secret: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });
    expect(switched.status).toBe(200);
    const saved = await sheets(repo);
    expect(saved?.config).toMatchObject(config);
    for (const key of ['auth', 'googleAccountId', 'googleEmail'])
      expect(saved?.config).not.toHaveProperty(key);
    expect(google.revoked).toEqual([signIn]);
  });
});
