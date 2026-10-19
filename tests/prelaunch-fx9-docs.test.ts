// Final review (fx-9): the one-push release and its deploy order, what a leaked backup still
// allows, local backup copies, linked phones from before approvals, workspace deletion and the
// gateway session, the emergency stop, security.txt, CI coverage of docs-only and gateway-only
// pushes, the unused greeting rule, heartbeat wording, and the owner's legal facts however they
// are written.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LegalPage } from '../src/components/Legal';
import { pairingAllowed } from '../server/whatsapp/routes';
import { seedCompanies } from '../src/shared/seed';
import {
  GATEWAY_HEARTBEAT_MS,
  GATEWAY_HEARTBEAT_STALE_MS,
  type WhatsAppConnection,
} from '../src/shared/whatsapp';
import { ownerFact, ownerFactProblems, withOwnerFact } from './prelaunch-fx9-helpers';

// Windows checkouts may have CRLF line endings; prose is compared with its line breaks collapsed.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const prose = (file: string) => read(file).replace(/\s+/g, ' ');
// Source comments read as one sentence, without the // that starts each line.
const comments = (file: string) =>
  read(file)
    .replace(/\n\s*\/\/ ?/g, ' ')
    .replace(/\s+/g, ' ');
const legal = (kind: 'privacy' | 'terms' | 'data-deletion') =>
  renderToStaticMarkup(createElement(LegalPage, { kind }))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const deployment = read('docs/DEPLOYMENT.md');
const release = deployment
  .slice(deployment.indexOf('## 7. Release order'), deployment.indexOf('## 8. Owner actions'))
  .replace(/\s+/g, ' ');
const railway = prose('gateway/RAILWAY.md');
const runbook = read('docs/INCIDENT-RUNBOOK.md');
const runbookProse = runbook.replace(/\s+/g, ' ');

describe('the release goes out as one push (docs-privacy-2, gateway-6, docs-privacy-5, tests-ci-4)', () => {
  it('pushes once, after SQL part 1, with Wait for CI required, and says why', () => {
    expect(release).toContain('This release goes out as **one push**');
    expect(release).toContain('git push origin <release-sha>:main');
    expect(release.match(/git push origin /g)).toHaveLength(1);
    expect(release.indexOf('202610200001_prelaunch_fixes.sql')).toBeLessThan(
      release.indexOf('**One push:**'),
    );
    expect(release).toContain('**Wait for CI** is on');
    expect(release).toContain('It is required for this release');
    // The legal commit is the release head that goes out, with its date bumped.
    expect(release).toContain('that commit is `<release-sha>`');
    expect(release).toContain('set `LEGAL_LAST_UPDATED`');
  });

  it('says in all three guides that the gateway follows its backend, with nothing left of two pushes', () => {
    expect(railway).toContain(
      'It is required for the October 2026 release, which goes out as one push',
    );
    expect(prose('docs/GET-IT-RUNNING.md')).toContain(
      'with **Wait for CI** on (required, DEPLOYMENT.md §7, step 5)',
    );
    expect(deployment.replace(/\s+/g, ' ')).toContain(
      'It is required for the October 2026 release (§7, step 5)',
    );
    for (const [file, doc] of [
      ['docs/DEPLOYMENT.md', deployment],
      ['gateway/RAILWAY.md', railway],
      ['docs/GET-IT-RUNNING.md', read('docs/GET-IT-RUNNING.md')],
    ])
      for (const stale of [
        'second push',
        'push the backend part first',
        '<last-backend-sha>',
        'release notes',
        'must not run before its backend',
      ])
        expect(doc, `${file} still says "${stale}"`).not.toContain(stale);
  });

  it('states both deploy orders and the one window, in the deployment guide and the Railway guide', () => {
    expect(release).toContain(
      'Either deploy order between the Supabase function and the Railway gateway is safe for this release',
    );
    expect(release).toContain('**This gateway with the older backend**');
    expect(release).toContain('**This backend with the older gateway**');
    expect(release).toContain(
      'refuses linked-phone replies once the last heartbeat is over 90 seconds old',
    );
    expect(release).toContain('heartbeats cannot reach Orderly for about 20 seconds or more');
    expect(railway).toContain('heartbeats cannot reach Orderly for about 20 seconds or more');
    expect(railway).toContain('An older gateway with this backend: its 15-second heartbeats');
    // "Either order is safe" only together with the window and a link to the release steps.
    expect(railway).not.toContain('either order is safe. An older gateway');
    expect(railway).toContain('either order is still safe, with one short window');
    // The facts the window rests on: a beat about once a minute, a 3-minute limit now.
    expect(GATEWAY_HEARTBEAT_MS).toBe(60000);
    expect(GATEWAY_HEARTBEAT_STALE_MS).toBe(180000);
    // A beat leaves at most 67.5 s after the last, so it has at least 22.5 s against 90 s.
    expect(90000 - (GATEWAY_HEARTBEAT_MS + 7500)).toBeGreaterThanOrEqual(20000);
    // The gateway's tick and slack, as the window assumes.
    const policy = read('gateway/src/policy.ts');
    expect(policy).toContain('export const TICK_MS = 15000;');
    expect(policy).toContain('return now - lastStatusAt >= intervalMs - TICK_MS / 2;');
  });
});

describe('a leaked backup (docs-privacy-3)', () => {
  it('no longer claims a backup cannot sign anyone in, and says what it still holds', () => {
    const guide = prose('docs/BACKUP-AND-RESTORE.md');
    expect(guide).not.toContain('cannot sign anyone in');
    expect(guide).toContain('cannot reuse a live sign-in session');
    expect(guide).toContain("every account's password hash (`auth.users`)");
    expect(guide).toContain('new passwords and new authenticator setups for every account');
  });

  it('has the runbook reset passwords and authenticators and treat recent invites as exposed', () => {
    const reset = runbookProse.slice(
      runbookProse.indexOf('**Reset every account after a leaked backup**'),
    );
    expect(reset.length).toBeGreaterThan(100);
    expect(reset).toContain("`delete from auth.mfa_factors where user_id = '<user id>';`");
    expect(reset).toContain('**Send password reset link** on the sign-in page');
    expect(reset).toContain('send the invites again');
    // The sign-in page really offers that link.
    expect(read('src/App.tsx')).toContain('Send password reset link');
    expect(runbookProse).toContain('sign users out → reset every account');
    // The backup key file, if it was left on the laptop, is in the lost-laptop list.
    expect(runbookProse).toContain('`.local/orderly-backup-key.txt` if it was never moved');
  });

  it('is needed because the backup really keeps logins and authenticator secrets', async () => {
    const { STEPS } = (await import('../scripts/backup-db.mjs' as string)) as {
      STEPS: { kind: string; args: string[] }[];
    };
    const data = STEPS.find((step) => step.kind === 'data')!;
    for (const kept of ['auth.users', 'auth.mfa_factors']) expect(data.args).not.toContain(kept);
  });
});

describe('local backup copies (docs-privacy-7, docs-privacy-10)', () => {
  const check = "Get-ChildItem .local\\backups -Directory | Where-Object Name -notlike 'db-*'";

  it('removes every other plain export before the dashboard publishes the policy', () => {
    expect(read('docs/BACKUP-AND-RESTORE.md')).toContain(check);
    expect(release).toContain(check);
    expect(release.indexOf(check)).toBeLessThan(release.indexOf('**Dashboard:**'));
    // What the policy says the laptop keeps.
    expect(legal('privacy')).toContain('the computer itself keeps only the two newest copies');
  });

  it('keeps deleted copies only as long as the policy says', () => {
    const guide = prose('docs/BACKUP-AND-RESTORE.md');
    expect(guide).toContain('a personal OneDrive or Google Drive sync folder');
    expect(guide).toContain('Do not use a work or school OneDrive');
    expect(legal('privacy')).toContain('up to 30 more days in the cloud storage’s recycle bin');
  });

  it('says automatic deletion does not clear a failed task, as the database does it', () => {
    expect(legal('privacy')).toContain(
      'a task that failed for good keeps its contents until staff retry it or the restaurant erases that customer’s details (automatic deletion does not clear it)',
    );
    const sql = read('supabase/migrations/202610200001_prelaunch_fixes.sql');
    const retention = sql.slice(sql.indexOf('create or replace function public.run_retention('));
    expect(retention.slice(0, 2500)).toContain(
      "where company_id=p_company_id and status='done' and",
    );
  });
});

describe('linked phones from before approvals (docs-privacy-4)', () => {
  const company = seedCompanies[0]!;
  const linked = (status: WhatsAppConnection['status']): WhatsAppConnection => ({
    id: '5f0c9a59-3c1e-4c55-9c7c-2f3d1a4b5c6d',
    companyId: company.id,
    provider: 'baileys',
    generation: 1,
    revision: 1,
    status,
    updatedAt: '2026-10-19T09:00:00.000Z',
  });

  it('are named in the Terms and the guides, as the server allows them', () => {
    // No admin decision and a linked phone still in use: a new pairing is allowed.
    expect(company.linkedDeviceAllowed).toBeUndefined();
    expect(pairingAllowed(company, linked('connected'))).toBe(true);
    expect(pairingAllowed({ ...company, linkedDeviceAllowed: false }, linked('connected'))).toBe(
      false,
    );
    expect(legal('terms')).toContain(
      'Until the administrator decides, a business that already used a linked phone before approvals began may also pair again while that connection is still in use.',
    );
    expect(prose('docs/COMPLIANCE-NOTES-2026-10-18.md')).toContain(
      'a business from before approvals, on which the admin never decided, may pair again (any number) while its linked phone is still in use',
    );
    const section4 = deployment.slice(
      deployment.indexOf('## 4. WhatsApp'),
      deployment.indexOf('## 5.'),
    );
    expect(section4.replace(/\s+/g, ' ')).toContain('record a decision for each such business');
    expect(section4).toContain("not (c.data ? 'linkedDeviceAllowed')");
  });
});

describe('deleting a workspace ends its linked session (docs-privacy-6, gateway-4)', () => {
  const section = runbook.slice(runbook.indexOf('## 6. Delete a workspace on request'));
  const sectionProse = section.replace(/\s+/g, ' ');

  it('waits for the gateway to log the session as ended before the rows go', () => {
    const confirm = sectionProse.indexOf(
      'logs show `SESSION_DISCONNECTED` or `SESSION_RETIRED` with that connection id',
    );
    expect(confirm).toBeGreaterThan(0);
    expect(confirm).toBeLessThan(sectionProse.indexOf('**Delete the workspace**'));
    expect(sectionProse).toContain('Do not go on to step 6 before this');
    expect(sectionProse).toContain(
      'press **Disconnect** again until it finishes without that note',
    );
    // The gateway logs both lines, with the connection id.
    const supervisor = read('gateway/src/supervisor.ts');
    expect(supervisor).toContain("this.log('SESSION_DISCONNECTED', body.connectionId)");
    expect(supervisor).toContain("this.log('SESSION_RETIRED', connectionId)");
    // Which the dashboard note it refers to really says.
    expect(read('src/components/WhatsAppConnection.tsx')).toContain(
      'the old session could not be ended from here',
    );
    expect(legal('data-deletion')).toContain(
      'makes sure a linked phone’s session on Orderly’s gateway has ended, then deletes the workspace data',
    );
    expect(railway).toContain('Never delete the business');
    expect(prose('gateway/README.md')).toContain('delete a business only after its session ended');
  });
});

describe('the emergency stop says exactly what it stops (ai-pipeline-1)', () => {
  it('lists the refused AI routes and what still goes out', () => {
    expect(runbookProse).toContain(
      '**Test your bot**, **Test model** and **Connect and test** are refused with 503, so Orderly calls no AI provider',
    );
    expect(runbookProse).toContain(
      'the order-status notices staff actions send (accepting, declining, marking ready and the like)',
    );
    expect(runbookProse).toContain(
      'an automatic notice that was already queued as a WhatsApp send before the stop',
    );
    expect(runbookProse).not.toContain(
      'No AI calls and no automatic replies; queued bot replies and order reminders are not sent',
    );
  });
});

describe('security.txt and the other doc nits (docs-privacy-9, docs-privacy-10, tests-ci-5)', () => {
  it('documents the relative Policy link and the renewal the build gives security.txt', () => {
    const script = read('scripts/prerender-public.mjs');
    expect(script).toContain('Policy: /privacy');
    expect(script).toContain('180 * 24 * 60 * 60 * 1000');
    const owner = deployment.slice(deployment.indexOf('## 8. Owner actions')).replace(/\s+/g, ' ');
    expect(owner).toContain('**security.txt.**');
    expect(owner).toContain('redeploy the dashboard at least every five months');
    expect(owner).toContain('`Policy` stays the relative link `/privacy`');
  });

  it('removes SQL part 2 from the ledger on rollback, under the name it was recorded with', () => {
    const line =
      "delete from public.orderly_schema_migrations where name = '202610200002_order_followups.sql';";
    expect(release).toContain(line);
    expect(read('supabase/migrations/202610200002_order_followups.sql')).toContain(
      "insert into public.orderly_schema_migrations(name) values ('202610200002_order_followups.sql')",
    );
  });

  it('re-runs all jobs of a run on main, never deploy alone or a branch run', () => {
    expect(release).toContain('use **Re-run all jobs**, not only `deploy`');
    expect(release).toContain('never a run started by hand on another branch');
    expect(runbookProse).toContain('use **Re-run all jobs**');
    // Why: the tested bundle is kept only this long.
    expect(read('.github/workflows/deploy-backend.yml')).toContain('retention-days: 7');
  });

  it('gives the WhatsApp terms addresses without claiming they were checked', () => {
    const notes = prose('docs/COMPLIANCE-NOTES-2026-10-18.md');
    expect(notes).toContain('<https://www.whatsapp.com/legal/business-terms>');
    expect(notes).toContain('without opening them again, so confirm them before quoting');
  });
});

describe('docs-only and gateway-only pushes are still checked (tests-ci-2)', () => {
  it('runs the full npm test, docs and gateway wording included, on every push to main', () => {
    const check = read('.github/workflows/check-gateway.yml');
    const on = check.slice(check.indexOf('\non:'), check.indexOf('\npermissions:'));
    expect(on).toContain('push:\n    branches: [main]');
    expect(on).not.toMatch(/paths/);
    expect(check).toContain(
      '- name: Orderly tests, including the docs and gateway wording checks\n        run: npm test\n',
    );
    // vitest runs every test file, so the docs and gateway wording tests are part of it.
    expect(read('vitest.config.ts')).toContain("include: ['tests/**/*.test.ts']");
    expect(read('vitest.config.ts')).not.toContain('exclude');
    const readsDocs = readdirSync(join(process.cwd(), 'tests')).filter(
      (file) =>
        file.endsWith('.test.ts') && /read\(\s*'(docs|gateway)\//.test(read(`tests/${file}`)),
    );
    expect(readsDocs.length).toBeGreaterThan(5);
    // The backend deploy skips such pushes, and the guides say Check WhatsApp gateway covers them.
    for (const path of ["'docs/**'", "'**/*.md'", "'gateway/**'"])
      expect(read('.github/workflows/deploy-backend.yml')).toContain(path);
    expect(deployment.replace(/\s+/g, ' ')).toContain(
      'pushes that change only docs, Markdown or `gateway/` skip this workflow. **Check WhatsApp gateway** runs the same `npm test` on every push to `main`',
    );
    expect(prose('README.md')).toContain(
      'a push that changes only docs or `gateway/` is checked by **Check WhatsApp gateway** alone',
    );
  });
});

describe('the greeting and away message rule (gateway-5, F29)', () => {
  it('is not used anywhere, and the docs say so', () => {
    const users = ['server', 'src']
      .flatMap((dir) =>
        readdirSync(join(process.cwd(), dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
          .map((entry) => join(entry.parentPath, entry.name)),
      )
      .filter((file) => !file.endsWith(join('src', 'shared', 'whatsapp.ts')))
      .filter((file) => readFileSync(file, 'utf8').includes('isPhoneAutoMessage'));
    expect(users).toEqual([]);
    expect(comments('src/shared/whatsapp.ts')).toContain(
      'Not used yet: no setting lists those texts and nothing calls this',
    );
    expect(prose('gateway/README.md')).toContain('Orderly has no setting that recognises them');
    expect(prose('gateway/README.md')).toContain(
      'This test is a launch gate for every linked restaurant.',
    );
  });
});

describe('heartbeat wording (gateway-7)', () => {
  it('no longer says replies stop only after three missed reports', () => {
    // Three missed one-minute beats already reach the 3-minute limit; one missed beat does not.
    expect(3 * GATEWAY_HEARTBEAT_MS).toBeGreaterThanOrEqual(GATEWAY_HEARTBEAT_STALE_MS);
    expect(2 * (GATEWAY_HEARTBEAT_MS + 7500)).toBeLessThan(GATEWAY_HEARTBEAT_STALE_MS);
    for (const file of ['src/shared/whatsapp.ts', 'gateway/README.md', 'docs/DEPLOYMENT.md'])
      expect(comments(file), file).not.toMatch(/only after three missed/);
    expect(comments('src/shared/whatsapp.ts')).toContain(
      'one missed or late report is harmless, but two missed in a row can already reach the limit',
    );
    expect(prose('gateway/README.md')).toContain(
      'one missed heartbeat is harmless, two missed in a row can already reach the limit',
    );
  });
});

describe('the owner’s legal facts, however they are written (tests-ci-1)', () => {
  const placeholder =
    "const OPERATOR = '[OWNER TO CONFIRM: legal name and address of the business that runs Orderly]';\nconst BACKUP_DAYS = '[OWNER TO CONFIRM: number of]';\n";
  const longName =
    'Example Foods (Private) Limited, 12-B Main Boulevard, Gulberg III, Lahore 54660, Pakistan';

  it('reads a long value prettier moved to the next line, and other quotes', () => {
    expect(`const OPERATOR = '${longName}';`.length).toBeGreaterThan(100);
    const cases: [string, string][] = [
      [`const OPERATOR =\n  '${longName}';`, longName],
      [`const OPERATOR =\r\n  '${longName}';`, longName],
      [
        `const OPERATOR = "Dad's Kitchen (Private) Limited, Lahore";`,
        "Dad's Kitchen (Private) Limited, Lahore",
      ],
      [`const OPERATOR = 'Dad\\'s Kitchen, Lahore';`, "Dad's Kitchen, Lahore"],
      [
        'const OPERATOR = `Example Foods,\n  12 Mall Road, Lahore`;',
        'Example Foods, 12 Mall Road, Lahore',
      ],
      [
        "const OPERATOR =\n  'Example Foods (Private) Limited, ' +\n  '12 Mall Road, Lahore';",
        'Example Foods (Private) Limited, 12 Mall Road, Lahore',
      ],
    ];
    for (const [source, value] of cases) expect(ownerFact(source, 'OPERATOR'), source).toBe(value);
    for (const source of [
      "const BACKUP_DAYS = '14';",
      'const BACKUP_DAYS = 14;',
      'const BACKUP_DAYS =\n  "14";',
    ])
      expect(ownerFact(source, 'BACKUP_DAYS'), source).toBe('14');
    expect(ownerFact('const OPERATOR = `${name}`;', 'OPERATOR')).toBeUndefined();
  });

  it('keeps CI green once filled in, in any of those forms, and still catches mistakes', () => {
    expect(ownerFactProblems(placeholder, '14')).toEqual([]);
    for (const [operator, days] of [
      [`\n  '${longName}'`, "'14'"],
      [`"Dad's Kitchen (Private) Limited, Lahore"`, '14'],
      ['`Example Foods,\n  12 Mall Road, Lahore`', '"14"'],
    ]) {
      const filled = withOwnerFact(
        withOwnerFact(placeholder, 'OPERATOR', operator!),
        'BACKUP_DAYS',
        days!,
      );
      expect(filled).not.toContain('OWNER TO CONFIRM');
      expect(ownerFactProblems(filled, '14'), filled).toEqual([]);
      expect(ownerFactProblems(withOwnerFact(filled, 'BACKUP_DAYS', '90'), '14')).toEqual([
        'BACKUP_DAYS is 90, the backup task keeps 14',
      ]);
    }
    expect(
      ownerFactProblems(
        withOwnerFact(placeholder, 'OPERATOR', "'Example Foods [OWNER TO CONFIRM]'"),
        '14',
      ),
    ).toEqual(['OPERATOR is half filled in']);
    expect(ownerFactProblems('const OPERATOR = name;', '14')).toEqual([
      'OPERATOR is missing',
      'BACKUP_DAYS is missing',
    ]);
  });

  it('reads the real file the same way the two legal tests do', () => {
    const source = read('src/components/Legal.tsx');
    expect(ownerFact(source, 'OPERATOR')).toBeTruthy();
    expect(ownerFact(source, 'BACKUP_DAYS')).toBeTruthy();
    expect(legal('privacy')).toContain(`Orderly is run by ${ownerFact(source, 'OPERATOR')}.`);
  });
});
