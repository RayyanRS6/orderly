// sql-2: a business whose saved AI limits are exactly the old dashboard's untouched defaults (300
// replies an hour, 30 per customer) gets the new defaults (1,500 and 100) when part 1 is pasted,
// once; limits an owner chose stay.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { seedCompanies } from '../src/shared/seed';
import { migratedDb } from './helpers/migrated-db';

const [company, other] = [seedCompanies[0]!, seedCompanies[1]!];
// Part 1 as pasted again in the SQL editor (it is safe to rerun).
const PART_1 = readFileSync('supabase/migrations/202610200001_prelaunch_fixes.sql', 'utf8').replace(
  /^create extension [^;]+;\r?$/gm,
  '',
);
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

describe('sql-2: limits saved as the old defaults give way to the new ones', () => {
  it('clears exactly the old defaults, raises the settings revision, and does it once', async () => {
    await change(company.id, {
      aiLimits: { repliesPerCustomerPerHour: 30, repliesPerHour: 300 },
      settingsRevision: 4,
    });
    // Saved by a dashboard that sends all three limits: the owner chose these.
    const chosen = {
      repliesPerHour: 300,
      repliesPerCustomerPerHour: 30,
      messagesPerCustomerPerMinute: 25,
    };
    await change(other.id, { aiLimits: chosen });
    expect(await limits(company.id)).toEqual({ replies_per_hour: 300, replies_per_customer: 30 });

    await t.db.exec(PART_1);
    const cleared = await data(company.id);
    expect(cleared).not.toHaveProperty('aiLimits');
    expect(cleared.settingsRevision).toBe(5);
    expect(await limits(company.id)).toEqual({ replies_per_hour: 1500, replies_per_customer: 100 });
    expect((await data(other.id)).aiLimits).toEqual(chosen);
    expect(await limits(other.id)).toEqual({ replies_per_hour: 300, replies_per_customer: 30 });

    // Saved before settings revisions existed: its revision starts at 1.
    await change(other.id, { aiLimits: { repliesPerHour: 300, repliesPerCustomerPerHour: 30 } });
    await t.db.query("update companies set data=data-'settingsRevision' where id=$1", [other.id]);
    await t.db.exec(PART_1);
    expect(await data(other.id)).toMatchObject({ settingsRevision: 1 });
    expect(await data(other.id)).not.toHaveProperty('aiLimits');

    // A rerun changes nothing more.
    const before = [await data(company.id), await data(other.id)];
    await t.db.exec(PART_1);
    expect([await data(company.id), await data(other.id)]).toEqual(before);
  });

  it('leaves other saved limits as the owner set them', async () => {
    for (const aiLimits of [
      { repliesPerHour: 500, repliesPerCustomerPerHour: 30 },
      { repliesPerHour: 300, repliesPerCustomerPerHour: 40 },
      { repliesPerHour: 300 },
    ]) {
      await change(company.id, { aiLimits, settingsRevision: 2 });
      await t.db.exec(PART_1);
      expect(await data(company.id)).toMatchObject({ aiLimits, settingsRevision: 2 });
    }
  });
});
