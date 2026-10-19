// fx-12 docs: the runbook re-keys AI only once the emergency stop is lifted (Connect and test is
// refused during it), release step 8 says what an older worker does with order reminders as the
// part 2 header does, and the hosting plan records the dashboard's request budget from its real
// timers.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_POLL_MS, CONFIG_POLL_MS } from '../src/lib/polling';
import { ALERT_POLL_MS } from '../src/components/StaffAlerts';
import { GATEWAY_HEARTBEAT_MS } from '../src/shared/whatsapp';

// Windows checkouts may have CRLF line endings; prose is compared with its line breaks collapsed.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const prose = (text: string) => text.replace(/\s+/g, ' ');
const inOrder = (text: string, steps: string[]) => {
  const at = steps.map((step) => text.indexOf(step));
  expect(
    at.every((i) => i >= 0),
    JSON.stringify(steps),
  ).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
};

describe('runbook: a new AI key only after the emergency stop is lifted', () => {
  const runbook = read('docs/INCIDENT-RUNBOOK.md');
  const secrets = runbook.slice(
    runbook.indexOf('## 3. Secrets'),
    runbook.indexOf('## 4. Suspected breach'),
  );

  it('is true of the code: Connect and test is refused with 503 during the stop', () => {
    const management = read('server/management.ts');
    const connect = management.slice(management.indexOf("app.post('/ai/connect'"));
    expect(connect.slice(0, 200)).toContain('refuseWhilePaused();');
    expect(management).toMatch(/if \(automationPaused\(\)\)\s+throw new PublicError\([^)]*503/);
    expect(runbook).toContain(
      '**Test your bot**, **Test model** and **Connect and test** are refused with 503',
    );
  });

  it('never sends owners to Connect and test while the stop is on', () => {
    expect(runbook).not.toContain(
      "The owner revokes it in the provider's console and connects a new key",
    );
    const row = secrets.split('\n').find((line) => line.startsWith('| Restaurant AI keys'))!;
    expect(prose(row)).toContain(
      '**Connect and test** is refused with 503 while `ORDERLY_PAUSE_AUTOMATION` is on, so the new key is connected only after you lift the stop',
    );
    // Every line of the secrets section that names Connect and test also names the stop.
    for (const line of secrets.split('\n').filter((l) => l.includes('Connect and test')))
      expect(line).toMatch(/lift the stop|stop is lifted|Lift the stop/);
    // The rotation order and the lost-laptop paragraph point to the same exception.
    expect(prose(secrets)).toContain(
      'Restaurant AI keys are the exception: owners revoke the old key at once, but connect the new one only after you lift the stop',
    );
    expect(prose(secrets)).toContain(
      'ask every restaurant to re-key (a new AI key only once the stop is lifted, as below)',
    );
    expect(prose(runbook)).toContain(
      'revoke your AI key now and connect a new one once we tell you automation is back on',
    );
  });

  it('revokes, switches the bot off, lifts the stop, then connects and switches it on', () => {
    const steps = prose(
      secrets.slice(secrets.indexOf('**Restaurant AI keys after a stop.**')).split('\n\n')[0]!,
    );
    inOrder(steps, [
      '**Restaurant AI keys after a stop.**',
      'refused with 503 while `ORDERLY_PAUSE_AUTOMATION` is on',
      "revoke the leaked key in the provider's console straight away",
      'switch their bot off (**Bot settings → Pause automation**',
      'Then lift the stop (section 1, **Resume**)',
      '**Bot settings → AI model → Connect and test**',
      'switches the bot back on',
    ]);
    // Switching a bot off saves during the stop; only switching one on is refused.
    expect(read('server/app.ts')).toContain(
      'if (company.botEnabled && !stored.botEnabled && automationPaused())',
    );
  });
});

describe('release step 8 and the part 2 header agree on an older worker', () => {
  const deployment = read('docs/DEPLOYMENT.md');
  const release = prose(
    deployment.slice(deployment.indexOf('## 7. Release order'), deployment.indexOf('## 8. Owner')),
  );
  const part2 = read('supabase/migrations/202610200002_order_followups.sql');
  const header = prose(
    part2
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .map((line) => line.slice(2))
      .join(' '),
  );
  const OLDER_WORKER =
    'an older worker does not know them and ends each one as a failed job (a staff alert) or as done, unsent';

  it('says the same thing in the header, step 8 and the rollback', () => {
    expect(header).toContain(OLDER_WORKER);
    const step8 = release.slice(
      release.indexOf('8. **SQL part 2:**'),
      release.indexOf('To roll back'),
    );
    expect(step8).toContain(OLDER_WORKER);
    expect(step8).toContain('Never run it earlier');
    const rollback = release.slice(release.indexOf('1. **SQL part 2**'));
    expect(rollback.slice(0, 400)).toContain(
      'the older worker does not know them and would end each one as a failed job (a staff alert) or as done, unsent',
    );
    expect(release).not.toContain('would send an unknown job as a WhatsApp message');
    expect(release).not.toContain('turn each one into a failed job and a staff alert');
  });

  it('asks for old tabs to be reloaded, and checks with the cleanup’s own match', () => {
    const step8 = release.slice(
      release.indexOf('8. **SQL part 2:**'),
      release.indexOf('To roll back'),
    );
    inOrder(step8, [
      'ask each restaurant to reload every Orderly tab opened before the release',
      'Then paste `supabase/migrations/202610200002_order_followups.sql` and run it',
      'clears AI limits saved as exactly those old defaults once more',
      'this read-only check',
    ]);
    const where = `where data->'aiLimits' = '{"repliesPerHour":300,"repliesPerCustomerPerHour":30}'::jsonb;`;
    expect(step8).toContain(where);
    expect(part2).toContain(where);
    expect(prose(deployment)).toContain(
      'again clears AI limits saved as the old defaults (an older dashboard tab can save them after part 1)',
    );
  });
});

describe('hosting plan: the request budget per screen', () => {
  const plan = read('docs/FREE-HOSTING-PLAN.md');
  const budget = prose(plan.slice(plan.indexOf('## Request budget per screen')));
  const HOUR = 3_600_000;

  it('gives the per-screen calls the dashboard timers make', () => {
    expect(budget).not.toBe('');
    // Overview, Orders, Inbox and Activity: news check, staff alerts and the stop check.
    const onScreen = HOUR / ACTIVITY_POLL_MS + HOUR / ALERT_POLL_MS + HOUR / CONFIG_POLL_MS;
    expect(onScreen).toBeGreaterThanOrEqual(270);
    expect(onScreen).toBeLessThanOrEqual(330);
    expect(budget).toContain('roughly 300 an hour when quiet, up to about 600 during busy service');
    expect(budget).toContain(
      `news check every ${ACTIVITY_POLL_MS / 1000} s, staff alerts every minute, stop check every ${CONFIG_POLL_MS / 60000} min`,
    );
    expect(ALERT_POLL_MS).toBe(60_000);
    // Any other page: staff alerts and the stop check.
    expect(Math.round((HOUR / ALERT_POLL_MS + HOUR / CONFIG_POLL_MS) / 10) * 10).toBe(70);
    expect(budget).toContain('about 70 an hour');
  });

  it('counts each linked phone, the Free allowance, a weekly check and when to move to Pro', () => {
    const heartbeats = (30 * 24 * HOUR) / GATEWAY_HEARTBEAT_MS;
    expect(heartbeats).toBe(43_200);
    expect(budget).toContain(`${heartbeats.toLocaleString('en-US')} (a 30-day month)`);
    expect(budget).toContain('Supabase Free includes 500,000 Edge Function calls a month');
    expect(budget).toContain('**Every week,** open Supabase');
    expect(budget).toContain('**Usage** page');
    expect(budget).toContain(
      '**Move to Supabase Pro** before a third restaurant goes live or before a second always-on screen',
    );
  });
});
