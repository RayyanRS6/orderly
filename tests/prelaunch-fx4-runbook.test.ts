// The runbook's workspace deletion matches the schema and the deletion page, and its emergency
// steps say only what is true.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const runbook = read('docs/INCIDENT-RUNBOOK.md');
const migrations = readdirSync(join(process.cwd(), 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => read(`supabase/migrations/${name}`))
  .join('\n');

describe('workspace deletion by hand', () => {
  const section = runbook.slice(runbook.indexOf('## 6. Delete a workspace on request'));

  it('pauses, disconnects, exports, deletes and verifies, in that order', () => {
    const steps = [
      '**Confirm the request.**',
      '**Pause the bot and the menu page:**',
      '**Disconnect everything, in Orderly first.**',
      'WhatsApp → **Linked devices**',
      '**Export, then back up.**',
      '**Check nothing is running and list the accounts**',
      '**Delete the workspace**',
      '**Delete the accounts**',
      '**Verify**',
      '**Tell the owner**',
    ];
    const at = steps.map((step) => section.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('deletes the rows the schema does not cascade first, and names the business twice', () => {
    // Every table that points at a business goes with it.
    const toCompanies = [...migrations.matchAll(/references public\.companies\s*\(id\)([^,\n]*)/g)];
    expect(toCompanies.length).toBeGreaterThan(10);
    for (const [line, rest] of toCompanies) expect(rest, line).toContain('on delete cascade');
    // Tables pointing at a chat without a cascade must be emptied before the business goes.
    const blocking = [
      ...migrations.matchAll(/references public\.conversations\s*\(company_id,\s*id\)([^,\n]*)/g),
    ]
      .filter(([, rest]) => !rest!.includes('on delete cascade'))
      .map((match) => {
        const before = migrations.slice(0, match.index);
        return before.slice(before.lastIndexOf('create table')).match(/public\.(\w+)/)![1];
      });
    expect(blocking.sort()).toEqual(['orders', 'traces']);
    const sql = section.slice(section.indexOf('```sql\n   begin;'));
    const deletes = ['traces', 'orders', 'companies'].map((table) =>
      sql.indexOf(`delete from public.${table} where`),
    );
    expect(deletes.every((i) => i > 0)).toBe(true);
    expect([...deletes].sort((a, b) => a - b)).toEqual(deletes);
    expect(sql).toContain("delete from public.companies where id = '<id>' and slug = '<slug>';");
    expect(sql).toContain('if n <> 1 then raise exception');
    expect(sql).toContain(
      "public.audit_event('<id>', '<your auth user id>', 'admin.workspace_deleted')",
    );
    expect(migrations).toContain(
      'create function public.audit_event(p_company_id text,p_actor_id text,p_action text)',
    );
  });

  it('is what the deletion page promises', () => {
    const legal = read('src/components/Legal.tsx');
    expect(legal).toContain('it pauses the bot, disconnects WhatsApp, Google Sheets and AI keys');
    expect(section).toContain('**Integrations → Google Sheets → Disconnect**');
    expect(section).toContain('**Bot settings → AI model → Remove saved key**');
  });
});

describe('emergency steps', () => {
  it('redeploys with a project ref, never by re-running an old run', () => {
    expect(runbook).not.toContain('`npm run deploy:backend`');
    expect(runbook).toContain('--project-ref zygsuxgqkeedgcbjhfzx --use-api');
    expect(runbook).toContain('never an older one');
  });

  it('scopes the audit and payment claims to what is true', () => {
    expect(runbook).not.toContain('Audit rows cannot be deleted, which helps.');
    expect(runbook).toContain("The app's service-role key cannot delete audit rows");
    expect(runbook).not.toContain('Payments are not affected: Orderly never holds');
  });
});
