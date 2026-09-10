import { randomUUID } from 'node:crypto';
import { send } from '@vercel/queue';
import type { Job } from '../src/shared/types.js';
import type { Repository } from './repository.js';
import { appMode } from './config.js';

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
export class VercelJobQueue implements JobQueue {
  async enqueue(jobId: string): Promise<void> {
    await send('orderly-jobs', { jobId });
  }
}
export async function dispatchJob(repo: Repository, job: Job): Promise<void> {
  if (appMode() === 'demo') return;
  try {
    await new VercelJobQueue().enqueue(job.id);
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
