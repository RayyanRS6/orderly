// api-security-3 (F46): a settings save sent from an older copy of the settings (another tab,
// another person, a model connected meanwhile) is refused instead of undoing the newer change.
// Only pausing automation always goes through. Local demo store, no network.
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../server/security';
import type { AiDataApproval, Company } from '../src/shared/types';
import { company, demoApp, minutesAgo } from './helpers/demo-app';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const app = demoApp();
const repo = () => app.repo();
const stored = async () => (await repo().getCompany(company.id))!;
const bootstrapCompany = async () =>
  ((await (await app.request('/bootstrap')).json()) as { company: Company }).company;
const save = (body: unknown) => app.request(`/companies/${company.id}`, { method: 'PUT', body });
const STALE = {
  error: 'Settings changed in another tab or by another person. Reload to see the latest settings.',
  code: 'STALE_SETTINGS',
};

describe('api-security-3 (F46): settings saved from an older copy', () => {
  it('returns the revision, bumps it on every save and refuses an older copy', async () => {
    await repo().saveCompany({ ...company, botEnabled: false });
    const copy = await bootstrapCompany();
    expect(copy.settingsRevision).toBe(0);
    const first = await save({ ...copy, name: 'First tab' });
    expect(first.status).toBe(200);
    expect(((await first.json()) as Company).settingsRevision).toBe(1);
    expect(await stored()).toMatchObject({ name: 'First tab', settingsRevision: 1 });
    expect((await bootstrapCompany()).settingsRevision).toBe(1);
    // The second tab still holds revision 0.
    const stale = await save({ ...copy, phone: '+92 300 0000000' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual(STALE);
    expect(await stored()).toMatchObject({ name: 'First tab', phone: company.phone });
    // Reloaded, it saves.
    const reloaded = await bootstrapCompany();
    expect((await save({ ...reloaded, phone: '+92 300 0000000' })).status).toBe(200);
    expect(await stored()).toMatchObject({ phone: '+92 300 0000000', settingsRevision: 2 });
  });

  it('never lets an older copy switch a paused bot back on', async () => {
    await repo().saveCompany({ ...company, botEnabled: true });
    const copy = await bootstrapCompany();
    // Someone pauses automation in another tab.
    expect((await save({ ...copy, botEnabled: false })).status).toBe(200);
    const stale = await save({ ...copy, botEnabled: true, phone: '+92 300 1111111' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual(STALE);
    expect((await stored()).botEnabled).toBe(false);
  });

  it('always lets a pause through, and saves nothing else from the older copy', async () => {
    await repo().saveCompany({ ...company, botEnabled: true });
    const copy = await bootstrapCompany();
    expect((await save({ ...copy, name: 'Newer name' })).status).toBe(200);
    const pause = await save({ ...copy, botEnabled: false, name: 'Old tab name' });
    expect(pause.status).toBe(200);
    const paused = (await pause.json()) as Company;
    expect(paused).toMatchObject({ botEnabled: false, name: 'Newer name', settingsRevision: 2 });
    expect(await stored()).toMatchObject({ botEnabled: false, name: 'Newer name' });
  });

  it('keeps the AI approval when an older copy carries another model', async () => {
    const approval: AiDataApproval = {
      provider: 'anthropic',
      userId: 'owner-user',
      at: '2026-10-18T08:00:00.000Z',
      version: 'ai-data-terms-2026-10-18',
      noTrainingOptIn: true,
      paidTierAttested: false,
    };
    await repo().saveCompany({
      ...company,
      botEnabled: false,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0, aiApproval: approval },
      settingsRevision: 4,
    });
    await repo().saveIntegration(
      company.id,
      { kind: 'gemini', configured: true, status: 'connected', config: {} },
      encryptSecret('gemini-test-key-0001'),
    );
    const stale = await save({
      ...(await stored()),
      settingsRevision: 3,
      ai: { provider: 'gemini', model: 'gemini-2.5-flash-lite', monthlyBudgetUsd: 10 },
    });
    expect(stale.status).toBe(409);
    expect(await stored()).toMatchObject({
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      privacy: { aiDataApproved: true, aiApproval: approval },
      settingsRevision: 4,
    });
    // A current copy that keeps the model keeps the approval too.
    expect((await save({ ...(await stored()), name: 'Same model' })).status).toBe(200);
    expect((await stored()).privacy).toEqual({
      aiDataApproved: true,
      retentionDays: 0,
      aiApproval: approval,
    });
  });

  it('saves a copy without a revision as before, for dashboards from before it', async () => {
    await repo().saveCompany({ ...company, botEnabled: false, settingsRevision: 7 });
    const { settingsRevision: _revision, ...old } = await stored();
    expect((await save({ ...old, name: 'Old dashboard' })).status).toBe(200);
    expect(await stored()).toMatchObject({ name: 'Old dashboard', settingsRevision: 8 });
  });

  it('counts Connect and test as a settings change, so an older copy cannot undo it', async () => {
    await repo().saveCompany({ ...company, botEnabled: false });
    const copy = await bootstrapCompany();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"data":[]}', { status: 200 })),
    );
    generate.mockResolvedValue({
      output: { actions: [{ type: 'menu' }], response: { text: 'Menu.', askFor: 'none' } },
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    const connected = await app.request('/ai/connect', {
      body: {
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        apiKey: 'sk-ant-business-test-key-0001',
        approve: true,
        attest: { noTrainingOptIn: true },
      },
    });
    expect(connected.status).toBe(200);
    expect((await stored()).settingsRevision).toBe(1);
    expect((await save({ ...copy, name: 'Old tab' })).status).toBe(409);
    expect((await stored()).ai.provider).toBe('anthropic');
  });

  it('reads a sheet menu afresh after a switch of menu source', async () => {
    await repo().saveCompany({
      ...company,
      botEnabled: false,
      catalogSource: 'sheets',
      catalogSyncedAt: minutesAgo(30),
    });
    const copy = await bootstrapCompany();
    expect((await save({ ...copy, catalogSource: 'app' })).status).toBe(200);
    expect((await stored()).catalogSyncedAt).toBeUndefined();
    await repo().markCatalogSynced(company.id, minutesAgo(1));
    // An ordinary save keeps the time the Sheet was last read.
    const current = await bootstrapCompany();
    expect((await save({ ...current, name: 'Same source' })).status).toBe(200);
    expect((await stored()).catalogSyncedAt).toBeDefined();
  });
});
