// Database backups leave live sign-in sessions out, and the backup guide says what they hold.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Step = { kind: string; args: string[]; cli: string[] };
type BackupModule = { AUTH_SESSION_TABLES: string[]; STEPS: Step[] };
const load = async () => (await import('../scripts/backup-db.mjs' as string)) as BackupModule;
// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
// The values that follow each occurrence of a flag.
const after = (args: string[], flag: string) =>
  args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

describe('backup contents', () => {
  it('leaves sessions, refresh tokens and one-time codes out of both dump tools', async () => {
    const { AUTH_SESSION_TABLES, STEPS } = await load();
    expect(AUTH_SESSION_TABLES).toEqual(
      expect.arrayContaining(['auth.sessions', 'auth.refresh_tokens', 'auth.one_time_tokens']),
    );
    const data = STEPS.find((step) => step.kind === 'data')!;
    const pgDump = after(data.args, '--exclude-table');
    const cli = after(data.cli, '--exclude');
    for (const table of AUTH_SESSION_TABLES) {
      expect(pgDump, table).toContain(table);
      expect(cli, table).toContain(table);
    }
    // Logins and authenticator apps stay, so a restore keeps every account.
    for (const kept of ['auth.users', 'auth.mfa_factors', 'auth.identities']) {
      expect(pgDump).not.toContain(kept);
      expect(cli).not.toContain(kept);
    }
    expect(data.cli.slice(0, 2)).toEqual(['--data-only', '--use-copy']);
  });

  it('says in the guide and the runbook what a backup holds and leaves out', async () => {
    const { AUTH_SESSION_TABLES } = await load();
    const guide = read('docs/BACKUP-AND-RESTORE.md');
    for (const table of AUTH_SESSION_TABLES) expect(guide).toContain(`\`${table}\``);
    expect(guide).toContain('`auth.audit_log_entries`, with the IP addresses');
    expect(guide).toContain('everyone signs in again after a restore');
    const runbook = read('docs/INCIDENT-RUNBOOK.md');
    expect(runbook).toContain('`delete from auth.sessions;`');
    expect(runbook).toContain('Backups made by an older copy of `scripts/backup-db.mjs`');
  });

  it('keeps the backup key out of synced folders and gives the manual encrypt commands', () => {
    const guide = read('docs/BACKUP-AND-RESTORE.md');
    expect(guide).not.toContain('$HOME\\Desktop\\orderly-backup-key.txt');
    expect(guide).toContain('age-keygen -o .local\\orderly-backup-key.txt');
    const manual = guide.slice(
      guide.indexOf('## 3. Take a backup by hand'),
      guide.indexOf('## 4. Nightly backup'),
    );
    expect(manual).toContain('tar -czf $tarball -C $latest.FullName .');
    expect(manual).toContain("age -R '.local\\backup-recipient.txt'");
    expect(manual).not.toContain('as in section 4, and only then');
  });

  it('says how long the nightly task’s copies outlive its clean-up', () => {
    const guide = read('docs/BACKUP-AND-RESTORE.md');
    expect(guide).toContain('recycle bin for about 30 more days');
    expect(guide).toContain('only the two newest plain copies on the laptop');
    expect(guide).toContain('Old copies are removed only when this task runs');
  });
});
