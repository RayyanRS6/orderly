// The hosted store's pipeline health call (F02), without a network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRepository } from '../server/storage/supabase';
import { PublicError } from '../server/security';

const client = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), auth: { admin: {} } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));

let repo: SupabaseRepository;
beforeEach(() => {
  repo = new SupabaseRepository('https://x.supabase.co', 'k');
});
afterEach(() => {
  vi.resetAllMocks();
});

describe('pipeline health', () => {
  it('reads the database check', async () => {
    const health = {
      status: 'stalled',
      stalledJobs: 2,
      oldestDueAt: '2026-10-20T10:00:00.000Z',
      schedulerConfigured: true,
      recoveryScheduled: true,
      lastRecoverRun: { status: 'succeeded', at: '2026-10-20T10:04:00.000Z' },
      recentWorkerErrors: 3,
      dbSizeBytes: 12345678,
    };
    client.rpc.mockResolvedValue({ data: health, error: null });
    expect(await repo.pipelineHealth()).toEqual(health);
    expect(client.rpc).toHaveBeenCalledWith('orderly_pipeline_health');
  });

  it('asks for the migration when the check is missing, and never reports healthy', async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    const error = await repo.pipelineHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toContain('202610200001_prelaunch_fixes.sql');
    client.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(repo.pipelineHealth()).rejects.toThrow('Database operation failed');
  });
});
