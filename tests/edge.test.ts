import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEdgeApp } from '../server/edge';
import { MemoryRepository } from '../server/repository';
import { appMode } from '../server/config';
import { makeJob } from '../server/jobs';
import { processJob } from '../server/service';
import { seedCompanies } from '../src/shared/seed';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'founder' } }, error: null }) },
  }),
}));

const origin = 'https://orderly.example.workers.dev';
const base = 'https://project.supabase.co/orderly/api';
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', 'supabase');
  vi.stubEnv('APP_URL', origin);
  vi.stubEnv('CRON_SECRET', 'test-worker-secret');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Supabase edge gateway', () => {
  it('serves the prefixed API and allows the frontend preflight without a user token', async () => {
    const app = createEdgeApp(repo);
    const config = await app.request(`${base}/config`, { headers: { Origin: origin } });
    expect(config.status).toBe(200);
    expect(config.headers.get('access-control-allow-origin')).toBe(origin);
    const preflight = await app.request(`${base}/companies`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,x-company-id,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const privateRoute = await app.request(`${base}/companies`, { headers: { Origin: origin } });
    expect(privateRoute.status).toBe(401);
    expect(privateRoute.headers.get('access-control-allow-origin')).toBe(origin);
  });
  it('rejects other origins, even for public configuration and preflight', async () => {
    const app = createEdgeApp(repo);
    for (const method of ['GET', 'OPTIONS']) {
      const res = await app.request(`${base}/config`, {
        method,
        headers: { Origin: 'https://attacker.example' },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
  it('keeps the empty-account onboarding exception working behind the function prefix', async () => {
    vi.spyOn(repo, 'listCompanies').mockResolvedValue([]);
    vi.spyOn(repo, 'isAdmin').mockResolvedValue(true);
    const res = await createEdgeApp(repo).request(`${base}/account`, {
      headers: { Origin: origin, Authorization: 'Bearer valid-test-user-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isAdmin: true, companyCount: 0 });
  });
  it('requires the private worker token before claiming a saved job', async () => {
    const claim = vi.spyOn(repo, 'claimJob');
    for (const authorization of ['', 'Bearer valid-test-user-token']) {
      const res = await createEdgeApp(repo).request(`${base}/jobs/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ jobId: 'test' }),
      });
      expect(res.status).toBe(401);
    }
    expect(claim).not.toHaveBeenCalled();
  });
  it('acknowledges a worker callback while preserving a failed job for recovery', async () => {
    const order = (await repo.listOrders(seedCompanies[0].id))[0];
    const conversation = (await repo.getConversation(order.companyId, order.conversationId))!;
    await repo.saveConversation({ ...conversation, channel: 'whatsapp' });
    await repo.saveOrder({ ...order, sandbox: false });
    const job = makeJob(seedCompanies[0].id, 'sheet_sync', { orderId: order.id });
    await repo.insertJob(job);
    const tasks: Promise<unknown>[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createEdgeApp(repo, {
      waitUntil: (task) => {
        tasks.push(task);
      },
    });
    const response = await app.request(`${base}/jobs/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-worker-secret' },
      body: JSON.stringify({ jobId: job.id }),
    });
    expect(response.status).toBe(202);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    const saved = await repo.getJob(job.id);
    expect(saved?.status).toBe('pending');
    expect(saved?.attempts).toBe(1);
    expect(Date.parse(saved!.nextRunAt)).toBeGreaterThan(Date.now());
  });
  it('never serves unauthenticated demo mode on the hosted runtime', () => {
    vi.stubEnv('APP_MODE', 'demo');
    expect(() => appMode()).toThrow('Demo mode is local-only');
  });
  it('does not reclaim a slow worker before the hosted runtime has ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    const order = (await repo.listOrders(seedCompanies[0].id))[0];
    const job = makeJob(order.companyId, 'sheet_sync', { orderId: order.id });
    await repo.insertJob(job);
    let entered!: () => void;
    const processing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    vi.spyOn(repo, 'getCompany').mockImplementationOnce(() => {
      entered();
      return new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
    });
    const task = processJob(repo, job.id).catch(() => {});
    await processing;
    vi.setSystemTime(startedAt + 151000);
    expect(
      await repo.claimJob(
        job.id,
        new Date().toISOString(),
        new Date(Date.now() + 180000).toISOString(),
      ),
    ).toBeUndefined();
    release();
    await task;
  });
});
