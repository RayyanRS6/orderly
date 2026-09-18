import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { sendStaffAlert } from '../server/integrations/alerts';
import { makeJob } from '../server/jobs';
import { seedCompanies } from '../src/shared/seed';
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('APP_URL', 'https://orderly.example');
  vi.stubEnv('RESEND_API_KEY', 'test-mail-key');
  vi.stubEnv('ALERT_FROM_EMAIL', 'Orderly <alerts@example.test>');
  vi.spyOn(repo, 'alertRecipient').mockResolvedValue('staff@example.test');
  vi.spyOn(repo, 'alertPreferences').mockResolvedValue({
    enabled: true,
    responseMinutes: 10,
    emailVerified: true,
  });
  vi.spyOn(repo, 'hasOverdueAttention').mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('opt-in staff email delivery', () => {
  it('freezes the request before sending and reuses one idempotency key on a retry', async () => {
    const job = makeJob(seedCompanies[0].id, 'staff_alert', { userId: 'staff' });
    await repo.insertJob(job);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(sendStaffAlert(repo, job)).rejects.toThrow('HTTP 503');
    const stored = (await repo.getJob(job.id))!;
    expect(stored.payload.firstAttemptAt).toBeTruthy();
    vi.stubEnv('ALERT_FROM_EMAIL', 'New sender <new@example.test>');
    await sendStaffAlert(repo, stored);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(calls[0][1]?.headers).toMatchObject({ 'Idempotency-Key': `orderly-alert/${job.id}` });
    expect(JSON.stringify(await repo.getJob(job.id))).not.toContain('staff@example.test');
    expect((await repo.getJob(job.id))?.payload.emailId).toBe('mail-1');
    await sendStaffAlert(repo, (await repo.getJob(job.id))!);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not send after opt-out, membership loss or resolved work', async () => {
    const job = makeJob(seedCompanies[0].id, 'staff_alert', { userId: 'staff' });
    vi.mocked(repo.alertRecipient).mockResolvedValueOnce(null);
    await sendStaffAlert(repo, job);
    vi.mocked(repo.alertPreferences).mockResolvedValueOnce({
      enabled: false,
      responseMinutes: 10,
      emailVerified: true,
    });
    await sendStaffAlert(repo, job);
    vi.mocked(repo.hasOverdueAttention).mockResolvedValueOnce(false);
    await sendStaffAlert(repo, job);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('drops expired uncertain sends and changed recipient addresses', async () => {
    const job = makeJob(seedCompanies[0].id, 'staff_alert', {
      userId: 'staff',
      firstAttemptAt: new Date(Date.now() - 24 * 3600000).toISOString(),
    });
    await sendStaffAlert(repo, job);
    job.payload = {
      userId: 'staff',
      firstAttemptAt: new Date().toISOString(),
      recipientHash: 'previous-account-email',
    };
    await sendStaffAlert(repo, job);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('blocks email without server configuration and never exposes provider response bodies', async () => {
    const job = makeJob(seedCompanies[0].id, 'staff_alert', { userId: 'staff' });
    await repo.insertJob(job);
    vi.stubEnv('RESEND_API_KEY', '');
    await expect(sendStaffAlert(repo, job)).rejects.toThrow('configured mail service');
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('RESEND_API_KEY', 'test-mail-key');
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('private-provider-detail', { status: 401 }),
    );
    await expect(sendStaffAlert(repo, job)).rejects.toThrow('HTTP 401');
  });
});
