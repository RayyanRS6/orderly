import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Job } from '../src/shared/types.js';
import type { Repository } from './repository.js';
import { appMode, requiredEnv } from './config.js';

export function makeJob(
  companyId: string,
  kind: Job['kind'],
  payload: Job['payload'],
  id: string = randomUUID(),
): Job {
  const now = new Date().toISOString();
  return {
    id,
    companyId,
    kind,
    payload,
    status: 'pending',
    attempts: 0,
    nextRunAt: now,
    createdAt: now,
  };
}
export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
}
export class SupabaseJobQueue implements JobQueue {
  async enqueue(jobId: string): Promise<void> {
    const client = createClient(
      requiredEnv('SUPABASE_URL'),
      requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
                : AbortSignal.timeout(5000),
            }),
        },
      },
    );
    const { error } = await client.rpc('dispatch_orderly_job', { p_job_id: jobId });
    if (error) throw new Error('Unable to dispatch the saved job.');
  }
}
export async function dispatchJob(repo: Repository, job: Job): Promise<void> {
  if (appMode() === 'demo') return;
  try {
    await new SupabaseJobQueue().enqueue(job.id);
  } catch {
    await repo.addTrace({
      id: randomUUID(),
      companyId: job.companyId,
      action: 'queue.dispatch_pending',
      detail: 'Job is saved. The scheduled recovery task will retry dispatch.',
      createdAt: new Date().toISOString(),
    });
  }
}
export async function recoverJobs(repo: Repository): Promise<number> {
  const jobs = await repo.listDueJobs(50);
  for (const job of jobs) await dispatchJob(repo, job);
  return jobs.length;
}
