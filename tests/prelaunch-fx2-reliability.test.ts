// ai-pipeline-3, ai-pipeline-7 and tests-ci-8: a Sheet refresh another chat started is waited
// for, a busy WhatsApp connection does not use up a young reply's tries, and worker leases never
// end before a Free-plan worker is stopped.
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret, PublicError } from '../server/security';
import { processJob } from '../server/service';
import { workerLeaseMs } from '../server/config';
import { makeJob } from '../server/jobs';
import { GoogleSheetsAdapter } from '../server/integrations/sheets';
import type { Company } from '../src/shared/types';
import { company, products, turnStore } from './helpers/fx2-turns';

const { repo, chat, say } = turnStore();
const sheetsConnected = () =>
  repo().saveIntegration(
    company.id,
    {
      kind: 'sheets',
      configured: true,
      status: 'connected',
      config: { spreadsheetId: 'sheet-id', catalogSheet: 'Menu' },
    },
    encryptSecret('unused-private-key'),
  );
// A Sheet menu last read 13 hours ago, after a quiet night.
async function quietNight() {
  const sheetMenu: Company = {
    ...company,
    catalogSource: 'sheets',
    catalogSyncedAt: new Date(Date.now() - 13 * 3600000).toISOString(),
  };
  await repo().saveCompany(sheetMenu);
  return sheetMenu;
}

describe('ai-pipeline-3: a Sheet refresh another chat started is waited for', () => {
  it('serves both chats after a quiet night instead of sending the second to staff', async () => {
    // Refreshes are limited per clock minute: a fixed mid-minute time keeps both chats in one
    // minute however the test is timed. Only Date is faked; the Sheet read and polls still wait.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T08:00:30.000Z'));
    await sheetsConnected();
    const read = vi
      .spyOn(GoogleSheetsAdapter.prototype, 'readCatalog')
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(products), 1500)),
      );
    const sheetMenu = await quietNight();
    const [first, second] = await Promise.all([
      say(sheetMenu, chat(), 'menu'),
      // A moment later, while the first chat's refresh is still reading the Sheet.
      new Promise((resolve) => setTimeout(resolve, 200)).then(() => say(sheetMenu, chat(), 'menu')),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.saved.mode).toBe('bot');
    expect(second.saved.mode).toBe('bot');
    expect(second.result.reply).toContain('Chicken Biryani');
  });

  it('still hands the second chat to staff when that refresh fails', async () => {
    await sheetsConnected();
    const read = vi
      .spyOn(GoogleSheetsAdapter.prototype, 'readCatalog')
      .mockRejectedValue(new PublicError('Row 3 is invalid.', 422));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(new Date('2026-10-20T08:00:00.000Z'));
    const sheetMenu = await quietNight();
    expect((await say(sheetMenu, chat(), 'menu')).saved.mode).toBe('human');
    const waiting = say(sheetMenu, chat(), 'menu');
    await vi.advanceTimersByTimeAsync(30000);
    expect((await waiting).saved.mode).toBe('human');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('ai-pipeline-7: a busy WhatsApp connection does not use up a reply’s tries', () => {
  it('keeps the tries of a young reply, and counts them once the reply is old', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    const c = { ...chat(), version: 1 };
    expect(await repo().saveConversation(c, 0)).toBe(true);
    const job = makeJob(company.id, 'whatsapp_send', {
      conversationId: c.id,
      messageId: 'reply-1',
      text: 'Hello',
      source: 'notice',
    });
    await repo().insertJob(job);
    // Another send (or a pairing) holds the business's connection.
    const holdConnection = (owner: string) =>
      repo().acquireConversationLock(
        company.id,
        'whatsapp-connection',
        owner,
        new Date(Date.now() + 10 * 60000).toISOString(),
      );
    expect(await holdConnection('other-send')).toBe(true);
    const young = processJob(repo(), job.id);
    await vi.advanceTimersByTimeAsync(31000);
    await young;
    expect(await repo().getJob(job.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      error: 'Waiting for the WhatsApp connection, which is busy.',
    });
    // Twenty minutes later the connection is still busy: now it counts as a failed try.
    vi.setSystemTime(Date.now() + 20 * 60000);
    expect(await holdConnection('another-send')).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const old = processJob(repo(), job.id).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31000);
    expect(await old).toMatchObject({ status: 503 });
    expect(await repo().getJob(job.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'WhatsApp connection is busy.',
    });
  });
});

describe('tests-ci-8: worker leases never end before a Free-plan worker is stopped', () => {
  it('ignores a lease shorter than 160 s and keeps the 180 s default', () => {
    for (const short of ['60', '90', '120', '150', '159']) {
      vi.stubEnv('WORKER_LEASE_SECONDS', short);
      expect(workerLeaseMs(), short).toBe(180_000);
    }
    for (const [seconds, ms] of [
      ['160', 160_000],
      ['180', 180_000],
      ['480', 480_000],
      ['900', 900_000],
    ] as const) {
      vi.stubEnv('WORKER_LEASE_SECONDS', seconds);
      expect(workerLeaseMs(), seconds).toBe(ms);
    }
    vi.stubEnv('WORKER_LEASE_SECONDS', '901');
    expect(workerLeaseMs()).toBe(180_000);
  });
});
