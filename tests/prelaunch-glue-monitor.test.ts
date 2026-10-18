// An outside monitor's pipeline health check, and the platform-wide emergency stop in the API.
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { PublicError } from '../server/security';
import { makeJob } from '../server/jobs';
import { company, demoApp, minutesAgo } from './helpers/demo-app';

const auth = vi.hoisted(() => ({
  createClient: vi.fn(() => {
    throw new Error('Supabase must not be used here');
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: auth.createClient }));

const app = demoApp();
const monitorToken = 'test-monitor-token-for-glue-checks-0123456789';

describe('pipeline health for an outside monitor', () => {
  const health = (authorization?: string) =>
    app.request('/health/pipeline', {
      headers: authorization ? { Authorization: authorization } : {},
    });

  it('is off, like an unknown route, without the token setting or the right bearer token', async () => {
    for (const response of [await health(), await health(`Bearer ${monitorToken}`)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'API route not found.' });
    }
    vi.stubEnv('HEALTH_CHECK_TOKEN', monitorToken);
    for (const header of [undefined, 'Bearer wrong-token', monitorToken, `Basic ${monitorToken}`]) {
      const response = await health(header);
      expect(response.status, String(header)).toBe(404);
      expect(await response.json()).toEqual({ error: 'API route not found.' });
    }
  });

  it('answers with coarse counts only: 200 when ok, 503 when work is not being sent', async () => {
    vi.stubEnv('HEALTH_CHECK_TOKEN', monitorToken);
    const ok = await health(`Bearer ${monitorToken}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'dbSizeBytes',
        'oldestDueAt',
        'recoveryScheduled',
        'schedulerConfigured',
        'stalledJobs',
        'status',
      ].sort(),
    );
    expect(body).toMatchObject({ status: 'ok', stalledJobs: 0, oldestDueAt: null });

    await app.repo().insertJob({
      ...makeJob(company.id, 'sheet_sync', {}),
      nextRunAt: minutesAgo(10),
    });
    const stalled = await health(`Bearer ${monitorToken}`);
    expect(stalled.status).toBe(503);
    const text = await stalled.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'stalled', stalledJobs: 1 });
    // Never which business, job or customer.
    expect(text).not.toContain(company.id);
    expect(JSON.parse(text)).not.toHaveProperty('lastRecoverRun');
    expect(JSON.parse(text)).not.toHaveProperty('recentWorkerErrors');
  });

  it('answers 503 when the database check is missing or fails, logging only the unexpected', async () => {
    vi.stubEnv('HEALTH_CHECK_TOKEN', monitorToken);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const check = vi.spyOn(app.repo(), 'pipelineHealth');
    check.mockRejectedValueOnce(
      new PublicError('Apply the 202610200001_prelaunch_fixes.sql database migration first.', 503),
    );
    const missing = await health(`Bearer ${monitorToken}`);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ status: 'unavailable' });
    expect(log).not.toHaveBeenCalled();
    check.mockRejectedValueOnce(new Error('connection reset'));
    const failed = await health(`Bearer ${monitorToken}`);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ status: 'unavailable' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      event: 'pipeline_health_failed',
    });
  });

  it('is checked before sign-in, so the monitor needs no account', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.stubEnv('HEALTH_CHECK_TOKEN', monitorToken);
    auth.createClient.mockClear();
    const response = await createApp(app.repo()).request(
      'http://127.0.0.1:4000/api/health/pipeline',
      { headers: { Authorization: `Bearer ${monitorToken}` } },
    );
    expect(response.status).toBe(200);
    expect(auth.createClient).not.toHaveBeenCalled();
  });
});

describe('the platform-wide emergency stop in the dashboard API', () => {
  it('tells the dashboard whether automation is paused', async () => {
    expect(await (await app.request('/config')).json()).toMatchObject({ automationPaused: false });
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', 'on');
    expect(await (await app.request('/config')).json()).toMatchObject({ automationPaused: true });
  });

  it('refuses to switch automation on while it is paused, but saves a bot already on', async () => {
    const repo = app.repo();
    const off = { ...company, botEnabled: false };
    await repo.saveCompany(off);
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', 'on');
    const refused = await app.request(`/companies/${company.id}`, {
      method: 'PUT',
      body: { ...off, botEnabled: true, name: 'Renamed' },
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain('paused across Orderly');
    expect(await repo.getCompany(company.id)).toMatchObject({ botEnabled: false, name: off.name });

    await repo.saveCompany({ ...off, botEnabled: true });
    const kept = await app.request(`/companies/${company.id}`, {
      method: 'PUT',
      body: { ...off, botEnabled: true, name: 'Renamed' },
    });
    expect(kept.status).toBe(200);
    expect(await repo.getCompany(company.id)).toMatchObject({ botEnabled: true, name: 'Renamed' });

    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
    await repo.saveCompany(off);
    const allowed = await app.request(`/companies/${company.id}`, {
      method: 'PUT',
      body: { ...off, botEnabled: true },
    });
    expect(allowed.status).toBe(200);
  });
});
