import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { makeJob } from '../server/jobs';
import { seedCompanies } from '../src/shared/seed';
import type { Job } from '../src/shared/types';

const now = '2026-09-10T10:00:00.000Z';
const lease = '2026-09-10T10:01:30.000Z';
const company = seedCompanies[0].id;
const otherCompany = seedCompanies[1].id;
let repo: MemoryRepository;

const incoming = (id: string, phone = '923001234567', companyId = company) =>
  makeJob(companyId, 'incoming', { phone, messageId: id, text: id }, id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  repo = new MemoryRepository();
});
afterEach(() => vi.useRealTimers());

describe('incoming job ordering', () => {
  it('refuses a later confirmation claim until the earlier edit completes', async () => {
    const edit = incoming('edit');
    const confirm = incoming('confirm');
    await repo.insertJob(edit);
    await repo.insertJob(confirm);

    expect(await repo.claimJob(confirm.id, now, lease)).toBeUndefined();
    const claimed = await repo.claimJob(edit.id, now, lease);
    expect(claimed?.id).toBe(edit.id);
    expect(await repo.claimJob(confirm.id, now, lease)).toBeUndefined();
    await repo.saveJob({ ...claimed!, status: 'done', leaseUntil: undefined });
    expect((await repo.claimJob(confirm.id, now, lease))?.id).toBe(confirm.id);
  });

  it('uses arrival order even when timestamps and retry backoff suggest another order', async () => {
    const edit = { ...incoming('edit'), nextRunAt: '2026-09-10T10:05:00.000Z' };
    const confirm = { ...incoming('confirm'), createdAt: '2026-09-09T10:00:00.000Z' };
    await repo.insertJob(edit);
    await repo.insertJob(confirm);
    expect(await repo.claimJob(confirm.id, now, lease)).toBeUndefined();
    expect(await repo.listDueJobs(100)).toEqual([]);

    // Updating the predecessor must not move it behind a later arrival.
    await repo.saveJob({ ...edit, nextRunAt: now });
    expect((await repo.listDueJobs(100)).map((job) => job.id)).toEqual(['edit']);
  });

  it('keeps failed incoming jobs as barriers until staff retry and they complete', async () => {
    const edit = incoming('edit');
    const confirm = incoming('confirm');
    await repo.insertJob(edit);
    await repo.insertJob(confirm);
    await repo.saveJob({ ...edit, status: 'failed', attempts: 5 });
    expect(await repo.claimJob(confirm.id, now, lease)).toBeUndefined();
    expect(await repo.listDueJobs(100)).toEqual([]);
    expect(await repo.retryFailedJobs(company)).toBe(1);
    expect(await repo.claimJob(confirm.id, now, lease)).toBeUndefined();
    const retried = await repo.claimJob(edit.id, now, lease);
    expect(retried?.attempts).toBe(1);
    await repo.saveJob({ ...retried!, status: 'done', leaseUntil: undefined });
    expect((await repo.listDueJobs(100)).map((job) => job.id)).toEqual(['confirm']);
  });

  it('reclaims the expired head rather than allowing a later incoming job past it', async () => {
    const edit = incoming('edit');
    const confirm = incoming('confirm');
    await repo.insertJob(edit);
    await repo.insertJob(confirm);
    await repo.claimJob(edit.id, now, lease);
    vi.setSystemTime(new Date(lease));
    const nextLease = '2026-09-10T10:03:00.000Z';
    expect(await repo.claimJob(confirm.id, lease, nextLease)).toBeUndefined();
    expect((await repo.listDueJobs(100)).map((job) => job.id)).toEqual(['edit']);
    expect((await repo.claimJob(edit.id, lease, nextLease))?.attempts).toBe(2);
  });

  it('keeps different phones, companies and outbound work independent', async () => {
    const failed: Job = { ...incoming('failed'), status: 'failed' };
    const blocked = incoming('blocked');
    const phone = incoming('other-phone', '923009999999');
    const tenant = incoming('other-company', '923001234567', otherCompany);
    const outbound = makeJob(company, 'sheet_sync', {}, 'outbound');
    for (const job of [failed, blocked, phone, tenant, outbound]) await repo.insertJob(job);
    const due = (await repo.listDueJobs(100)).map((job) => job.id);
    expect(due).toEqual(['other-phone', 'other-company', 'outbound']);
    for (const job of [phone, tenant, outbound])
      expect((await repo.claimJob(job.id, now, lease))?.id).toBe(job.id);
  });

  it('filters blocked jobs before applying the recovery batch size', async () => {
    await repo.insertJob({ ...incoming('failed'), status: 'failed' });
    for (let index = 0; index < 55; index++) await repo.insertJob(incoming(`blocked-${index}`));
    await repo.insertJob(incoming('ready', '923008888888'));
    expect((await repo.listDueJobs(1)).map((job) => job.id)).toEqual(['ready']);
  });

  it('only claims the head when later and earlier callbacks race', async () => {
    await repo.insertJob(incoming('edit'));
    await repo.insertJob(incoming('confirm'));
    const claims = await Promise.all([
      repo.claimJob('confirm', now, lease),
      repo.claimJob('edit', now, lease),
      repo.claimJob('edit', now, lease),
    ]);
    expect(claims.map((job) => job?.id)).toEqual([undefined, 'edit', undefined]);
  });
});
