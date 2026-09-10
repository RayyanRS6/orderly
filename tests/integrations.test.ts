import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app';
import { MemoryRepository, SupabaseRepository } from '../server/repository';
import { WhatsAppAdapter } from '../server/integrations/whatsapp';
import { seedCompanies } from '../src/shared/seed';
import type { Integration } from '../src/shared/types';

const company = seedCompanies[0];
const other = seedCompanies[1];
const spreadsheetId = 'test_spreadsheet_123456789';
const sheets = (ordersSheet?: string, id = spreadsheetId): Integration => ({
  kind: 'sheets',
  configured: true,
  status: 'configured',
  config: { spreadsheetId: id, ...(ordersSheet === undefined ? {} : { ordersSheet }) },
});

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('integration destination and registration safeguards', () => {
  it('allows only one company to claim the default Orders destination concurrently', async () => {
    const repo = new MemoryRepository();
    const results = await Promise.allSettled([
      repo.saveIntegration(company.id, sheets(), 'first-secret'),
      repo.saveIntegration(other.id, sheets('oRdErS'), 'second-secret'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.status).toBe(409);
    const integrations = await Promise.all([
      repo.getIntegrations(company.id),
      repo.getIntegrations(other.id),
    ]);
    expect(integrations.flat()).toHaveLength(1);
  });

  it('allows different tabs and retains the previous connection after a conflicting edit', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, sheets(), 'first-secret');
    await repo.saveIntegration(other.id, sheets('Other orders'), 'original-secret');
    await expect(repo.saveIntegration(other.id, sheets(''), 'replacement-secret')).rejects.toThrow(
      'already assigned',
    );
    expect((await repo.getIntegrations(other.id))[0].config.ordersSheet).toBe('Other orders');
    expect(await repo.getSecret(other.id, 'sheets')).toBe('original-secret');
    await repo.saveIntegration(company.id, sheets('ORDERS'), 'rotated-secret');
    expect(await repo.getSecret(company.id, 'sheets')).toBe('rotated-secret');
  });

  it('returns a useful tenant-safe API conflict without overwriting the original connection', async () => {
    const repo = new MemoryRepository();
    await repo.saveIntegration(company.id, sheets(), 'original-secret');
    const response = await createApp(repo).request('http://127.0.0.1/api/integrations/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-company-id': other.id },
      body: JSON.stringify({ config: sheets('Orders').config, secret: 'new-private-key' }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('Choose a different spreadsheet or orders tab');
    expect(body.error).not.toContain(company.name);
    expect(body.error).not.toContain(company.id);
    expect(await repo.getIntegrations(other.id)).toHaveLength(0);
    expect(await repo.getSecret(company.id, 'sheets')).toBe('original-secret');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('translates the PostgREST uniqueness error into the same public conflict', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "integrations_sheet_destination_unique"',
          details: 'Key values are intentionally not exposed to the user.',
          hint: null,
        },
        { status: 409 },
      ),
    );
    const repo = new SupabaseRepository('https://test.supabase.co', 'fake-service-role-key');
    await expect(
      repo.saveIntegration(company.id, sheets(), 'encrypted-secret'),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Choose a different spreadsheet or orders tab'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses standard registration for a coexistence number before contacting Meta', async () => {
    const adapter = new WhatsAppAdapter(
      {
        kind: 'whatsapp',
        configured: true,
        status: 'configured',
        config: { phoneNumberId: '12345', coexistence: 'true' },
      },
      'fake-token',
    );
    await expect(adapter.register('123456')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('coexistence onboarding'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps normal Cloud API number registration available', async () => {
    vi.stubEnv('META_GRAPH_VERSION', 'v25.0');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true }));
    const adapter = new WhatsAppAdapter(
      {
        kind: 'whatsapp',
        configured: true,
        status: 'configured',
        config: { phoneNumberId: '12345', coexistence: 'false' },
      },
      'fake-token',
    );
    await expect(adapter.register('123456')).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/12345/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: '123456' }),
      }),
    );
  });
});

describe('Postgres spreadsheet destination uniqueness', () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    `);
    await db.exec(readFileSync('supabase/migrations/202609090001_initial.sql', 'utf8'));
  }, 30000);
  beforeEach(async () => {
    await db.exec('truncate public.companies cascade');
    for (const c of seedCompanies)
      await db.query('insert into companies(id,slug,data) values($1,$2,$3)', [c.id, c.slug, c]);
  });
  afterAll(async () => {
    await db.close();
  });
  const save = (id: string, integration: Integration, secret = 'ciphertext') =>
    db.query('select public.save_integration($1,$2,$3)', [id, integration, secret]);

  it('atomically rejects a cross-company duplicate despite tab case or an omitted default', async () => {
    const results = await Promise.allSettled([
      save(company.id, sheets()),
      save(other.id, sheets('ORDERS')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('23505');
    expect((await db.query('select * from integrations')).rows).toHaveLength(1);
    expect((await db.query('select * from integration_secrets')).rows).toHaveLength(1);
  });

  it('permits separate tabs, blocks an empty-name default collision and rolls back secrets', async () => {
    await save(company.id, sheets());
    await save(other.id, sheets('Other orders'), 'original-ciphertext');
    await expect(save(other.id, sheets(''), 'replacement-ciphertext')).rejects.toMatchObject({
      code: '23505',
    });
    const connection = (
      await db.query<{ data: Integration }>('select data from integrations where company_id=$1', [
        other.id,
      ])
    ).rows[0].data;
    expect(connection.config.ordersSheet).toBe('Other orders');
    const secret = (
      await db.query<{ encrypted_secret: string }>(
        'select encrypted_secret from integration_secrets where company_id=$1',
        [other.id],
      )
    ).rows[0].encrypted_secret;
    expect(secret).toBe('original-ciphertext');
    await save(company.id, sheets('Orders'), 'rotated-ciphertext');
  });

  it('checks ownership on activation while allowing separate spreadsheets', async () => {
    await save(company.id, sheets());
    await save(other.id, { ...sheets(), configured: false });
    await expect(save(other.id, sheets())).rejects.toMatchObject({ code: '23505' });
    await save(other.id, sheets('Orders', 'another_test_spreadsheet_123456789'));
    expect((await db.query('select * from integrations')).rows).toHaveLength(2);
  });
});
