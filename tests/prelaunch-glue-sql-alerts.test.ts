// Staff alerts for a linked phone that stopped working (F04), in 202610200001_prelaunch_fixes.sql
// on the whole migration chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedCompanies } from '../src/shared/seed';
import type { StaffAttention } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const other = seedCompanies[1]!;
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
const attention = (companyId = company.id) => rpc<StaffAttention>('staff_attention', [companyId]);
const overdue = (minutes: number) => rpc<boolean>('has_overdue_attention', [company.id, minutes]);
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(() => t.reset());
afterAll(() => t.db.close());

describe('staff alerts for a linked phone that stopped working (F04)', () => {
  const connectionId = '5f0c9a59-3c1e-4c55-9c7c-2f3d1a4b5c6d';
  // Replaces the business's connection, as the backend saves it.
  async function connection(fields: Record<string, unknown>, companyId = company.id) {
    const current = await scalar<number | null>(
      'select revision as value from whatsapp_connections where company_id=$1',
      [companyId],
    );
    const revision = (current ?? 0) + 1;
    const data = {
      id: companyId === company.id ? connectionId : randomUUID(),
      companyId,
      provider: 'baileys',
      generation: 1,
      revision,
      status: 'connected',
      accountJid: '923001234567@s.whatsapp.net',
      lastHeartbeatAt: now(),
      updatedAt: now(),
      ...fields,
    };
    for (const [key, value] of Object.entries(fields))
      if (value === undefined) delete (data as Record<string, unknown>)[key];
    expect(await rpc('save_whatsapp_connection', [data, revision - 1])).toBe(true);
  }
  const items = async () => (await attention()).items.filter((a) => a.kind === 'whatsapp');

  it('shows nothing for a phone that reports, and the stalled phone at once', async () => {
    await connection({});
    expect(await attention()).toMatchObject({ total: 0, whatsapp: 0, items: [] });
    expect(await overdue(120)).toBe(false);
    const beat = minutesAgo(4);
    await connection({ lastHeartbeatAt: beat });
    const [item] = await items();
    expect(item).toEqual({
      id: `whatsapp:${connectionId}`,
      kind: 'whatsapp',
      entityId: connectionId,
      createdAt: expect.any(String),
    });
    expect(Date.parse(item!.createdAt)).toBe(Date.parse(beat));
    expect(await attention()).toMatchObject({ total: 1, whatsapp: 1, handoffs: 0, failures: 0 });
    expect(await overdue(120)).toBe(true);
    // A connected phone that never reported is as silent.
    await connection({ lastHeartbeatAt: undefined, updatedAt: minutesAgo(10) });
    expect(await items()).toHaveLength(1);
  });

  it('waits 3 minutes in the bell, and the alert delay for email, while it reconnects', async () => {
    await connection({ status: 'reconnecting', downSince: minutesAgo(2) });
    expect(await items()).toEqual([]);
    expect(await overdue(5)).toBe(false);
    const since = minutesAgo(12);
    // Each attempt refreshes the heartbeat; only downSince shows how long it has been down.
    await connection({ status: 'reconnecting', downSince: since, lastHeartbeatAt: now() });
    expect((await items()).map((a) => Date.parse(a.createdAt))).toEqual([Date.parse(since)]);
    expect(await overdue(10)).toBe(true);
    expect(await overdue(15)).toBe(false);
    // Saved before downSince existed: when it last changed.
    await connection({ status: 'connecting', updatedAt: minutesAgo(20) });
    expect(await overdue(15)).toBe(true);
    expect(await overdue(30)).toBe(false);
  });

  it('alerts at once for a phone logged out or failed', async () => {
    for (const status of ['logged_out', 'error']) {
      await connection({ status });
      expect(await items(), status).toHaveLength(1);
      expect(await overdue(120), status).toBe(true);
    }
  });

  it('ignores a pairing in progress, the official route, a paused bot and other businesses', async () => {
    await connection({ status: 'error', accountJid: undefined });
    expect(await items()).toEqual([]);
    await connection({ status: 'awaiting_pairing', accountJid: undefined });
    expect(await items()).toEqual([]);
    await connection({ status: 'error', provider: 'meta' });
    expect(await items()).toEqual([]);
    await connection({ status: 'logged_out' });
    await t.db.query(
      "update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1",
      [company.id],
    );
    expect(await items()).toEqual([]);
    expect(await overdue(5)).toBe(false);
    await connection({ status: 'logged_out', accountJid: '923009999999@s.whatsapp.net' }, other.id);
    expect(await attention(other.id)).toMatchObject({ whatsapp: 1 });
    expect(await items()).toEqual([]);
  });

  it('is queued as an email alert for a subscriber', async () => {
    const user = randomUUID();
    await t.db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'a@example.test',now())",
      [user],
    );
    await t.db.query("insert into company_memberships values($1,$2,'owner')", [company.id, user]);
    await rpc('configure_alerts', [company.id, user, true, 10]);
    await connection({});
    expect(await rpc('queue_staff_alerts')).toBe(0);
    await connection({ status: 'logged_out' });
    expect(await rpc('queue_staff_alerts')).toBe(1);
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    for (const signature of [
      'public.whatsapp_down(text,integer)',
      'public.staff_attention(text)',
      'public.has_overdue_attention(text,integer)',
    ]) {
      expect(
        await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [role, signature]),
        signature,
      ).toBe(false);
      expect(
        await scalar(`select has_function_privilege('service_role',$1,'EXECUTE') as value`, [
          signature,
        ]),
        signature,
      ).toBe(true);
    }
  });
});
