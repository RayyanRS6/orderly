// sql-2, release window: between part 1 (§7 step 2) and the dashboard deploy (step 7) a dashboard
// from before the release fills its Limits boxes with 300 and 30 again, so Save limits there
// stores the old defaults once more. Part 2 runs after the dashboard deploy (step 8) and clears
// them the same way part 1 does, once; limits an owner chose stay.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { seedCompanies } from '../src/shared/seed';
import { migratedDb } from './helpers/migrated-db';

const [company, other] = [seedCompanies[0]!, seedCompanies[1]!];
const read = (file: string) =>
  readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/\r\n/g, '\n');
// Part 2 as pasted in the SQL editor after the dashboard deploy (it is safe to rerun).
const PART_2 = read('202610200002_order_followups.sql');
const OLD_DEFAULTS = { repliesPerHour: 300, repliesPerCustomerPerHour: 30 };
// The cleanup statement: from its update to the old defaults it matches.
const cleanup = (sql: string) =>
  sql.match(/update public\.companies set data = \(data - 'aiLimits'\)[^;]+;/g) ?? [];

let t: Awaited<ReturnType<typeof migratedDb>>;
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(() => t.reset());
afterAll(() => t.db.close());

const data = (id: string) =>
  t.scalar<Record<string, unknown>>('select data as value from companies where id=$1', [id]);
const change = (id: string, fields: Record<string, unknown>) =>
  t.db.query('update companies set data=data||$2::jsonb where id=$1', [id, fields]);
const limits = async (id: string) =>
  (
    await t.db.query<{ replies_per_hour: number; replies_per_customer: number }>(
      'select s.* from companies c, ai_limit_settings(c.data) s where c.id=$1',
      [id],
    )
  ).rows[0];

describe('sql-2: part 2 clears the old defaults an older dashboard saved again', () => {
  it('runs the very same cleanup as part 1, after the dashboard deploy', () => {
    const part1 = cleanup(read('202610200001_prelaunch_fixes.sql'));
    const part2 = cleanup(PART_2);
    expect(part1).toHaveLength(1);
    expect(part2).toEqual(part1);
    expect(part2[0]).toContain(
      `where data->'aiLimits' = '{"repliesPerHour":300,"repliesPerCustomerPerHour":30}'::jsonb`,
    );
    // It runs before part 2 records itself, so a stop on a lock leaves part 2 unrecorded.
    expect(PART_2.indexOf(part2[0]!)).toBeLessThan(
      PART_2.indexOf('insert into public.orderly_schema_migrations'),
    );
  });

  it('clears an old-tab save made after part 1, raises the revision, and does it once', async () => {
    // Part 1 cleared it (revision 1); an older tab then saved its prefilled 300 and 30 (revision 2).
    await change(company.id, { aiLimits: OLD_DEFAULTS, settingsRevision: 2 });
    // A tab from before settings revisions: no revision at all.
    await change(other.id, { aiLimits: { repliesPerCustomerPerHour: 30, repliesPerHour: 300 } });
    await t.db.query("update companies set data=data-'settingsRevision' where id=$1", [other.id]);
    expect(await limits(company.id)).toEqual({ replies_per_hour: 300, replies_per_customer: 30 });

    await t.db.exec(PART_2);
    const cleared = await data(company.id);
    expect(cleared).not.toHaveProperty('aiLimits');
    expect(cleared.settingsRevision).toBe(3);
    expect(await limits(company.id)).toEqual({ replies_per_hour: 1500, replies_per_customer: 100 });
    expect(await data(other.id)).toMatchObject({ settingsRevision: 1 });
    expect(await data(other.id)).not.toHaveProperty('aiLimits');
    expect(await limits(other.id)).toEqual({ replies_per_hour: 1500, replies_per_customer: 100 });

    // A rerun changes nothing more, and part 2 stays recorded once.
    const before = [await data(company.id), await data(other.id)];
    await t.db.exec(PART_2);
    expect([await data(company.id), await data(other.id)]).toEqual(before);
    expect(
      await t.scalar(
        "select count(*)::int as value from orderly_schema_migrations where name='202610200002_order_followups.sql'",
      ),
    ).toBe(1);
  });

  it('leaves limits an owner chose as they are', async () => {
    for (const aiLimits of [
      // Every save from the new dashboard includes the per-minute limit, even at 300 and 30.
      { ...OLD_DEFAULTS, messagesPerCustomerPerMinute: 25 },
      { repliesPerHour: 500, repliesPerCustomerPerHour: 30 },
      { repliesPerHour: 300, repliesPerCustomerPerHour: 40 },
      { repliesPerHour: 300 },
      { repliesPerHour: 1500, repliesPerCustomerPerHour: 100 },
    ]) {
      await change(company.id, { aiLimits, settingsRevision: 2 });
      await t.db.exec(PART_2);
      expect(await data(company.id)).toMatchObject({ aiLimits, settingsRevision: 2 });
    }
  });
});
