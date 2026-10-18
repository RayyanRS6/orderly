// What the scheduler helper (scripts/configure-scheduler.mjs) says when the database refuses
// (F57), without a network: a missing function is not fixed by re-applying migrations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const client = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));

let dir: string;
let argv: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orderly-scheduler-'));
  // Fictional values only.
  writeFileSync(
    join(dir, 'server.env'),
    'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=fictional-service-key\nCRON_SECRET=fictional-cron-secret-0123456789abcdef\n',
  );
  argv = process.argv;
  process.argv = [argv[0]!, 'configure-scheduler.mjs', join(dir, 'server.env')];
  vi.resetModules();
});
afterEach(() => {
  process.argv = argv;
  rmSync(dir, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
const run = () => import('../scripts/configure-scheduler.mjs' as string);
const fail = async () => ((await run().catch((e: unknown) => e)) as Error).message;

describe('the scheduler helper', () => {
  it('says a function is missing without suggesting re-applying migrations', async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    const message = await fail();
    expect(message).toContain('has no configure_orderly_scheduler function');
    expect(message).toContain('never re-apply the folder');
    expect(message).not.toMatch(/apply the scheduler migration/i);
    expect(message).not.toContain('fictional');
  });

  it('tells a refused setting apart, with the database reason and no secrets', async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'Worker token must contain 32 to 512 URL-safe or base64 characters',
      },
    });
    const message = await fail();
    expect(message).toContain('refused the scheduler settings: Worker token must contain');
    expect(message).toContain('CRON_SECRET');
    expect(message).not.toContain('fictional');
  });

  it('prints the readiness flags once set up', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    client.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: { configured: true, recoveryScheduled: true }, error: null });
    await run();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ configured: true, recoveryScheduled: true }));
    expect(client.rpc).toHaveBeenCalledWith('configure_orderly_scheduler', {
      p_worker_url:
        'https://abcdefghijklmnopqrst.supabase.co/functions/v1/orderly/api/jobs/process',
      p_worker_token: 'fictional-cron-secret-0123456789abcdef',
    });
  });
});
