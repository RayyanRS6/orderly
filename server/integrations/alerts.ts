import { createHash, randomUUID } from 'node:crypto';
import { appMode, env, requiredEnv } from '../config.js';
import type { Repository } from '../repository.js';
import type { Job } from '../../src/shared/types.js';
import { PublicError } from '../security.js';

export function emailAlertsAvailable() {
  return appMode() === 'live' && !!env('RESEND_API_KEY') && !!env('ALERT_FROM_EMAIL');
}
export async function sendStaffAlert(repo: Repository, job: Job) {
  if (typeof job.payload.emailId === 'string') return;
  const userId = String(job.payload.userId ?? '');
  const recipient = await repo.alertRecipient(job.companyId, userId);
  const preferences = await repo.alertPreferences(job.companyId, userId);
  const first =
    typeof job.payload.firstAttemptAt === 'string'
      ? Date.parse(job.payload.firstAttemptAt)
      : undefined;
  // A stale digest is unnecessary; an uncertain send must not outlive Resend's 24h dedupe window.
  if (
    !recipient ||
    !preferences.enabled ||
    !(await repo.hasOverdueAttention(job.companyId, preferences.responseMinutes)) ||
    (first !== undefined && (!Number.isFinite(first) || Date.now() - first >= 23 * 3600000)) ||
    (first === undefined && Date.now() - Date.parse(job.createdAt) > 2 * 3600000)
  ) {
    job.payload.skipped = true;
    return;
  }
  if (!emailAlertsAvailable())
    throw new PublicError('Email alerts need a configured mail service and verified sender.', 503);
  const recipientHash = createHash('sha256').update(recipient).digest('hex');
  if (job.payload.recipientHash && job.payload.recipientHash !== recipientHash) {
    job.payload.skipped = true;
    return;
  }
  if (first === undefined) {
    const origin = new URL(requiredEnv('APP_URL'));
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw new PublicError('Email alerts require an HTTPS app address.', 503);
    // Freeze request parameters before the first send, retaining no recipient address in jobs.
    job.payload = {
      ...job.payload,
      recipientHash,
      firstAttemptAt: new Date().toISOString(),
      from: requiredEnv('ALERT_FROM_EMAIL'),
      text: `Orderly has unresolved work or an AI budget warning for a business you manage. Sign in to review pending orders, human handoffs, failed jobs and spending.\n\n${origin.origin}/app\n\nYou opted in to these alerts. To stop them, open Staff alerts in that business and turn off email alerts. No customer details are included in this email.`,
    };
    await repo.saveJob(job);
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requiredEnv('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `orderly-alert/${job.id}`,
    },
    body: JSON.stringify({
      from: job.payload.from,
      to: [recipient],
      subject: 'Orderly needs your attention',
      text: job.payload.text,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new PublicError(
      `Email provider rejected the alert (HTTP ${response.status}). Check the sender and quota.`,
      503,
    );
  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== 'string' || !result.id)
    throw new PublicError('Email provider returned no acceptance receipt.', 503);
  job.payload.emailId = result.id;
  await repo.saveJob(job);
  await repo.addTrace({
    id: randomUUID(),
    companyId: job.companyId,
    action: 'email.accepted',
    detail: 'Staff alert accepted by the mail provider. This is not a delivery or read receipt.',
    createdAt: new Date().toISOString(),
  });
}
