// The release order, its rollback and the CI notes in the deployment guide match the workflows,
// the Railway watch paths and the migrations they describe.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const deployment = read('docs/DEPLOYMENT.md');
const release = deployment.slice(
  deployment.indexOf('## 7. Release order'),
  deployment.indexOf('## 8. Owner actions'),
);

describe('release order', () => {
  // Owner decision (fx-9): the history interleaves gateway and backend commits, so the release
  // goes out as one push with Railway's Wait for CI on, instead of two pushes.
  it('goes out as one push, with Wait for CI on, before the dashboard', () => {
    const steps = [
      '**Legal text:**',
      '**Railway, Wait for CI:**',
      '**One push:**',
      'git push origin <release-sha>:main',
      '**Dashboard:**',
      '202610200002_order_followups.sql',
    ];
    const at = steps.map((step) => release.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const gone of ['<last-backend-sha>', 'release notes', '**Gateway, second push:**'])
      expect(release).not.toContain(gone);
  });

  it('lists what the push brings to Railway with every Railway watch path', () => {
    const railway = read('gateway/RAILWAY.md');
    const watch = railway.match(/\| Build → Watch Paths\s*\|([^|]+)\|/)![1]!;
    const paths = [...watch.matchAll(/`(!?)\/([^`]+)`/g)].map(([, not, path]) => ({
      not: !!not,
      path: path!.replace(/\/\*\*$/, ''),
    }));
    expect(paths.length).toBeGreaterThanOrEqual(4);
    const check = release.match(/git log --oneline origin\/main\.\.<release-sha> -- (.+)/)![1]!;
    for (const { not, path } of paths)
      if (not) expect(check, path).toContain(`':!gateway/*.md'`);
      else expect(check.split(' '), path).toContain(path);
  });

  it('requires the owner placeholders filled in before the dashboard is built', () => {
    const legal = release.indexOf('**Legal text:**');
    expect(release.slice(legal)).toMatch(
      /^\*\*Legal text:\*\* replace every `\[OWNER TO CONFIRM: …\]` in `src\/components\/Legal\.tsx`/,
    );
    expect(release).toContain(
      "`Select-String -Path src\\components\\Legal.tsx -Pattern 'OWNER TO CONFIRM'` must print nothing",
    );
    expect(legal).toBeLessThan(release.indexOf('**Dashboard:**'));
  });

  it('spells out the rollback of both SQL parts, with names that exist', () => {
    const followups = read('supabase/migrations/202610200002_order_followups.sql');
    expect(followups).toContain("cron.schedule('orderly-order-followups'");
    expect(followups).toContain('function public.queue_order_followups()');
    expect(release).toContain(
      "select cron.unschedule(jobid) from cron.job where jobname = 'orderly-order-followups';",
    );
    expect(release).toContain('drop function if exists public.queue_order_followups();');
    expect(release).toContain("where status = 'pending' and data->>'kind' = 'order_followup';");
    expect(release).toContain('`.local/backups/rollback-prelaunch-2026-10-20.sql`');
    expect(release).not.toContain('or left, if it is additive');
    expect(release).not.toContain("check the file's own rollback notes");
    // Part 2 goes before the older backend, the backend revert after the dashboard.
    const order = [
      '**SQL part 2**',
      '**Dashboard:** `npx wrangler rollback`',
      '**Backend:** revert',
    ];
    const at = order.map((step) => release.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('CI notes', () => {
  it('say which pushes run the backend checks, and that an old re-run deploys old code', () => {
    expect(read('README.md')).toContain(
      'on every push to `main` that changes more than docs, Markdown or `gateway/`',
    );
    expect(deployment).toContain(
      '**Re-running an older run deploys that older commit over newer code**',
    );
    expect(deployment).toContain('never replaces a waiting `main` deploy');
    expect(read('docs/ORDERLY-AUDIT-CLOSURE-2026-09-18.md')).toContain(
      'Worker leases (row P1-06) now follow `WORKER_LEASE_SECONDS`',
    );
  });
});
