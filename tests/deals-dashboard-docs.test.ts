// The deals release in the deployment guide (§7b): the read-only check's md5 values are the
// repo's, the live check really saves a deal and an order and then keeps nothing, and the
// rollback goes in the safe order. The runbook's workspace deletion covers deals.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { migratedDb } from './helpers/migrated-db';

// Windows checkouts may have CRLF line endings.
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const deployment = read('docs/DEPLOYMENT.md');
const section = deployment.slice(
  deployment.indexOf('## 7b. Release order (deals'),
  deployment.indexOf('## 8. Owner actions'),
);
const prose = section.replace(/\s+/g, ' ');
const DEALS = '202610210001_deals.sql';
const PASSED = 'Deals live check passed. Nothing was saved.';
const md5 = (text: string) => createHash('md5').update(text.replace(/\r/g, '')).digest('hex');
// The body of the last definition of a function in these migration files, as Postgres keeps it
// (prosrc: the text between the dollar quotes).
function body(name: string, files: string[]) {
  let found: string | undefined;
  const definition = new RegExp(`create (?:or replace )?function public\\.${name}\\(`, 'g');
  for (const file of files) {
    const sql = read(`supabase/migrations/${file}`);
    for (const match of sql.matchAll(definition)) {
      const start = sql.indexOf('$$', match.index) + 2;
      found = sql.slice(start, sql.indexOf('$$', start));
    }
  }
  return found!;
}
const files = readdirSync('supabase/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort();
const before = files.filter((name) => name < DEALS);
const expected = (name: string) =>
  section.match(new RegExp(`\\| \`${name}\`\\s*\\| \`([0-9a-f]{32})\` \\|`))?.[1];
const liveCheck = section
  .slice(
    section.indexOf('```sql\n   do $$'),
    section.indexOf('end $$;', section.indexOf('```sql\n   do $$')) + 'end $$;'.length,
  )
  .replace('```sql\n', '')
  .replace(/^ {3}/gm, '');

let t: Awaited<ReturnType<typeof migratedDb>>;
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(async () => {
  await t.reset();
});
afterAll(() => t.db.close());

describe('the deals release (§7b)', () => {
  it('goes backup, compare, SQL, live check, backend, dashboard, with no push command', () => {
    const steps = [
      '1. **Backup:**',
      '2. **Compare first (read-only):**',
      `3. **SQL:** paste \`supabase/migrations/${DEALS}\``,
      '4. **Live check:**',
      '5. **Backend:** push to `main`.',
      '6. **Dashboard:**',
    ];
    const at = steps.map((step) => section.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(section).not.toContain('git push origin ');
    expect(deployment).toContain(`| \`${DEALS}\` (deals)`);
    // Staff reload open tabs before the first deal.
    expect(prose).toContain(
      'ask staff to reload every open Orderly tab (kitchen tablets too) before the owner adds the first deal',
    );
    // The menu page section says imports and Sheets refreshes leave deals alone.
    expect(deployment.replace(/\s+/g, ' ')).toContain(
      'CSV imports and Sheets refreshes leave them alone',
    );
  });

  it('compares production with the md5 of the repo’s functions before the deals SQL', async () => {
    const query = `select proname as name, md5(replace(prosrc, chr(13), '')) as value from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('validate_order_snapshot', 'enforce_json_references', 'replace_products')
      order by proname`;
    expect(section).toContain(
      "and proname in ('validate_order_snapshot', 'enforce_json_references', 'replace_products')",
    );
    const after = Object.fromEntries(
      (await t.db.query<{ name: string; value: string }>(query)).rows.map((r) => [r.name, r.value]),
    );
    // The way the bodies are read from the files gives what Postgres keeps.
    for (const name of Object.keys(after)) expect(md5(body(name, files)), name).toBe(after[name]);
    // The deals SQL leaves two of them alone and replaces the order check.
    for (const name of ['enforce_json_references', 'replace_products'])
      expect(expected(name), name).toBe(md5(body(name, before)));
    expect(expected('validate_order_snapshot')).toBe(md5(body('validate_order_snapshot', before)));
    expect(md5(body('enforce_json_references', before))).toBe(after.enforce_json_references);
    expect(md5(body('replace_products', before))).toBe(after.replace_products);
    expect(prose).toContain(
      `\`validate_order_snapshot\` now prints \`${after.validate_order_snapshot}\``,
    );
    // The rollback puts the order check back exactly as before.
    expect(prose).toContain(
      `puts \`validate_order_snapshot\` back exactly (\`${expected('validate_order_snapshot')}\` again)`,
    );
  });

  it('has a live check that saves a deal and an order, then keeps nothing', async () => {
    const company = seedCompanies[0]!.id;
    expect(liveCheck).toMatch(/^do \$\$/);
    expect(liveCheck).toContain("business text := '<test business id>';");
    const run = (sql = liveCheck) => t.db.exec(sql.replace('<test business id>', company));
    await expect(run()).rejects.toThrow(PASSED);
    const count = (table: string) =>
      t.scalar<number>(`select count(*)::int as value from public.${table}`);
    for (const table of ['deals', 'orders', 'conversations'])
      expect(await count(table), table).toBe(0);
    expect(await count('products')).toBe(seedProducts.length);
  });

  it('fails the live check when the one id space or the deal branch is missing', async () => {
    const company = seedCompanies[0]!.id;
    const run = () => t.db.exec(liveCheck.replace('<test business id>', company));
    await t.db.exec('begin');
    try {
      await t.db.exec('drop trigger catalog_id_unique on public.products');
      await expect(run()).rejects.toThrow("A menu item could take a deal's id");
    } finally {
      await t.db.exec('rollback');
    }
    // The order check as it was before deals.
    const hardening = read('supabase/migrations/202609160001_launch_hardening.sql');
    const start = hardening.indexOf('create or replace function public.validate_order_snapshot()');
    const old = hardening.slice(
      start,
      hardening.indexOf('$$;', hardening.indexOf('$$', start) + 2) + 3,
    );
    await t.db.exec('begin');
    try {
      await t.db.exec(old);
      await expect(run()).rejects.toThrow('Catalog changed: item unavailable');
    } finally {
      await t.db.exec('rollback');
    }
    await expect(run()).rejects.toThrow(PASSED);
  });

  it('rolls back by pausing every deal first, then the dashboard, then the backend', () => {
    const rollback = section.slice(section.indexOf('**Rollback**'));
    const steps = [
      '0. **Pause every deal first**',
      "update public.deals set data = jsonb_set(data, '{available}', 'false');",
      '1. **Dashboard:** `npx wrangler rollback',
      '2. **Backend:** revert the commit on `main`',
      '3. **The SQL can stay:**',
      '`.local/backups/rollback-deals.sql`',
    ];
    const at = steps.map((step) => rollback.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const text = rollback.replace(/\s+/g, ' ');
    expect(text).toContain('only once the older backend is live');
    expect(text).toContain('It keeps the `deals` table and every deal');
    expect(text).toContain('only after exporting its rows');
    expect(text).toContain('deletes the ledger row');
  });

  it('pauses with the same update the rollback file names', async () => {
    const company = seedCompanies[0]!.id;
    const deal = { id: 'd1', companyId: company, name: 'Deal 1', price: 1, available: true };
    await t.db.query('insert into public.deals(id, company_id, data) values($1, $2, $3)', [
      deal.id,
      company,
      deal,
    ]);
    await t.db.exec("update public.deals set data = jsonb_set(data, '{available}', 'false');");
    expect(await t.scalar("select data->'available' as value from public.deals")).toBe(false);
  });
});

describe('the incident runbook', () => {
  it('names deals among what deleting a workspace removes, and verifies they are gone', () => {
    const runbook = read('docs/INCIDENT-RUNBOOK.md');
    const deletion = runbook.slice(runbook.indexOf('## 6. Delete a workspace on request'));
    expect(deletion).toContain('menu, deals, menu page');
    expect(deletion).toContain(
      "(select count(*) from public.deals where company_id = '<id>') deals,",
    );
    // It goes with the business: its link to the business cascades.
    expect(read(`supabase/migrations/${DEALS}`)).toMatch(
      /references public\.companies\(id\) on delete cascade/,
    );
  });
});
