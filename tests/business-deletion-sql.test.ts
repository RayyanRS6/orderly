// Deleting a business in the database (202610220001_business_deletion.sql) on the whole
// migration chain: delete_company empties every table of that business but the audit table,
// leaves every other business alone, refuses while work runs, and a deleted business can never be
// saved back.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConversation, processTurn } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, Deal, DeletedBusiness } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const A = seedCompanies[0]!;
const B = seedCompanies[1]!;
const FILE = '202610220001_business_deletion.sql';
const DENIED = /permission denied for (function|table)/;
const now = () => new Date().toISOString();
const inPast = () => new Date(Date.now() - 3600000).toISOString();
const inFuture = () => new Date(Date.now() + 3600000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
const remove = (id = A.id, slug = A.slug, actor = 'admin-1') =>
  rpc<DeletedBusiness>('delete_company', [id, slug, actor]);
const check = (id = A.id, slug = A.slug) => rpc('check_company_deletable', [id, slug]);
const pause = (id = A.id) =>
  t.db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [id]);
let phones = 0;
const nextPhone = () => `+9230077${String(++phones).padStart(5, '0')}`;
// Windows checkouts may have CRLF line endings.
const docs = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(async () => {
  await t.reset();
});
afterAll(() => t.db.close());

// A placed WhatsApp order and its chat (with its messages), saved as the bot saves them.
async function placedOrder(companyId: string) {
  const company = seedCompanies.find((c) => c.id === companyId)!;
  const products = seedProducts.filter((p) => p.companyId === companyId);
  let conversation: Conversation = createConversation(companyId, nextPhone(), 'whatsapp', now());
  const turn = (action: BotAction) => {
    const result = processTurn(company, products, conversation, {
      messageId: randomUUID(),
      text: action.type === 'confirm' ? 'confirm' : 'test',
      action,
      now: now(),
    });
    conversation = result.conversation;
    return result;
  };
  // A dish with no sizes to choose, so it goes straight into the cart.
  turn({ type: 'add_item', productId: products.find((p) => !p.variants?.length)!.id, quantity: 1 });
  turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
  turn({ type: 'review' });
  const result = turn({ type: 'confirm' });
  if (!result.order) throw new Error(result.reply);
  result.conversation.version = 1;
  expect(
    await rpc('commit_turn', [companyId, result.conversation, 0, result.order, [], null]),
  ).toBe(true);
  return { conversation: result.conversation, order: result.order };
}

// A row in every table that holds a business's data.
async function fill(companyId: string) {
  const { conversation, order } = await placedOrder(companyId);
  const query = (text: string, args: unknown[]) => t.db.query(text, args);
  const user = randomUUID();
  await query('insert into auth.users(id) values($1)', [user]);
  await query("insert into company_memberships values($1,$2,'owner')", [companyId, user]);
  await query('insert into alert_subscriptions(company_id,user_id) values($1,$2)', [
    companyId,
    user,
  ]);
  const job = makeJob(companyId, 'incoming', { conversationId: conversation.id, phone: '' });
  expect(await rpc('insert_job', [job, `dedupe-${randomUUID()}`])).toBe(true);
  const traceId = randomUUID();
  await query(
    'insert into traces(id,company_id,conversation_id,data,created_at) values($1,$2,$3,$4,now())',
    [
      traceId,
      companyId,
      conversation.id,
      { id: traceId, companyId, conversationId: conversation.id, action: 'test' },
    ],
  );
  const usage = { id: randomUUID(), companyId, costUsd: 0.01, createdAt: now() };
  await rpc('record_usage', [usage]);
  await query(
    'insert into budget_reservations(id,company_id,amount_usd,expires_at) values($1,$2,0.01,$3)',
    [randomUUID(), companyId, inFuture()],
  );
  await rpc('record_delivery', [
    companyId,
    `wamid-${randomUUID()}`,
    'sent',
    conversation.id,
    'm1',
    null,
  ]);
  await rpc('save_integration', [
    companyId,
    { kind: 'openai', configured: true, status: 'connected', config: {} },
    'ciphertext',
  ]);
  await rpc('save_whatsapp_connection', [
    {
      id: randomUUID(),
      companyId,
      provider: 'baileys',
      generation: 1,
      revision: 1,
      status: 'disconnected',
      updatedAt: now(),
    },
    0,
  ]);
  const deal: Partial<Deal> = {
    id: randomUUID(),
    companyId,
    name: 'Deal',
    price: 1,
    available: true,
  };
  await query('insert into deals(id,company_id,data) values($1,$2,$3)', [deal.id, companyId, deal]);
  await rpc('set_menu_link', [companyId, true, `menu-${companyId.slice(0, 8)}`]);
  await query(
    'insert into menu_link_uses(company_id,nonce,conversation_id,order_id,expires_at) values($1,$2,$3,$4,$5)',
    [companyId, randomUUID().replace(/-/g, '').slice(0, 11), conversation.id, order.id, inFuture()],
  );
  await query(
    "insert into menu_drafts(id,company_id,code_hash,quoted_total,expires_at) values($1,$2,$3,100,now()+interval '30 minutes')",
    [randomUUID(), companyId, createHash('sha256').update(randomUUID()).digest('hex')],
  );
  await query(
    "insert into ai_limit_hits(company_id,scope,window_key,limit_value,resets_at) values($1,'hourly','2026-10-22T10',100,$2)",
    [companyId, inFuture()],
  );
  await query(
    "insert into blocked_customers(company_id,key,block_id) values($1,'pn:923001234567','block-1')",
    [companyId],
  );
  await query('insert into retention_policies(company_id) values($1)', [companyId]);
  // A lock that has ended, as a finished worker leaves one.
  await query(
    'insert into conversation_locks(company_id,conversation_id,owner_id,lease_until) values($1,$2,$3,$4)',
    [companyId, conversation.id, 'worker-1', inPast()],
  );
  await rpc('audit_event', [companyId, 'someone', 'test.action']);
  return { conversation, order };
}

// Every table with a company_id column (the companies table itself is counted by id).
async function tables() {
  return (
    await t.db.query<{ name: string }>(
      `select table_name as name from information_schema.columns
       where table_schema='public' and column_name='company_id' order by 1`,
    )
  ).rows.map((r) => r.name);
}
async function counts(companyId: string) {
  const out: Record<string, number> = {
    companies: await scalar<number>('select count(*)::int as value from companies where id=$1', [
      companyId,
    ]),
  };
  for (const name of await tables())
    out[name] = await scalar<number>(
      `select count(*)::int as value from public.${name} where company_id=$1`,
      [companyId],
    );
  return out;
}

describe('delete_company', () => {
  it('empties every table of that business but the audit table, and leaves the other alone', async () => {
    // A reset keeps audit rows (they point at no business): start this one without any.
    await t.db.exec('delete from audit_events');
    await fill(A.id);
    await fill(B.id);
    await pause();
    const before = await counts(A.id);
    const other = await counts(B.id);
    // The check is only as good as the rows: every table had one of this business.
    for (const [name, n] of Object.entries(before)) expect(n, name).toBeGreaterThan(0);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        'conversation_messages',
        'integration_secrets',
        'menu_link_uses',
        'message_deliveries',
        'whatsapp_connections',
        'deals',
      ]),
    );
    const connection = await scalar<string>(
      'select id as value from whatsapp_connections where company_id=$1',
      [A.id],
    );
    expect(await remove()).toEqual({
      orders: before.orders,
      conversations: before.conversations,
      products: before.products,
      deals: before.deals,
    });
    const after = await counts(A.id);
    for (const [name, n] of Object.entries(after))
      if (name !== 'audit_events') expect(n, name).toBe(0);
    // Who did it is kept, with no message text.
    expect(
      (
        await t.db.query(
          'select actor_id, action from audit_events where company_id=$1 order by id',
          [A.id],
        )
      ).rows,
    ).toEqual([
      { actor_id: 'someone', action: 'test.action' },
      { actor_id: 'admin-1', action: 'admin.workspace_deleted' },
    ]);
    expect(await counts(B.id)).toEqual(other);
    expect(
      await scalar('select deleted_by as value from deleted_companies where id=$1', [A.id]),
    ).toBe('admin-1');
    expect(
      await scalar<number>(
        'select count(*)::int as value from deleted_whatsapp_connections where id=$1',
        [connection],
      ),
    ).toBe(1);
    // The other business still takes orders.
    await placedOrder(B.id);
  });

  it('refuses a wrong slug, a business that is gone, a bot that is on and running work', async () => {
    const { conversation } = await placedOrder(A.id);
    const orders = () =>
      scalar<number>('select count(*)::int as value from orders where company_id=$1', [A.id]);
    // The check the backend asks first refuses exactly as the deletion does, and changes nothing.
    const refused = async (message: string) => {
      await expect(check()).rejects.toThrow(message);
      await expect(remove()).rejects.toThrow(message);
    };
    await refused('Pause automation before deleting this business');
    await pause();
    for (const [id, slug] of [
      [A.id, B.slug],
      ['no-such-business', A.slug],
    ] as const) {
      await expect(check(id, slug)).rejects.toThrow('Unknown company');
      await expect(remove(id, slug)).rejects.toThrow('Unknown company');
    }
    const job = { ...makeJob(A.id, 'incoming', { conversationId: conversation.id, phone: '' }) };
    await rpc('insert_job', [job, null]);
    await t.db.query(
      "update jobs set status='processing', lease_until=$2, data=data||jsonb_build_object('status','processing') where id=$1",
      [job.id, inFuture()],
    );
    await refused('Wait for running work before deleting this business');
    await t.db.query(
      'update jobs set status=\'done\', data=data||\'{"status":"done"}\' where id=$1',
      [job.id],
    );
    expect(await rpc('acquire_conversation_lock', [A.id, conversation.id, 'w', inFuture()])).toBe(
      true,
    );
    await refused('Wait for running work before deleting this business');
    expect(await orders()).toBe(1);
    expect(await scalar<number>('select count(*)::int as value from deleted_companies')).toBe(0);
    await rpc('release_conversation_lock', [A.id, conversation.id, 'w']);
    await check();
    expect(await orders()).toBe(1);
    expect(await scalar<number>('select count(*)::int as value from deleted_companies')).toBe(0);
    await remove();
    expect(await orders()).toBe(0);
    await expect(remove()).rejects.toThrow('Unknown company');
    await expect(check()).rejects.toThrow('Unknown company');
  });

  it('checks a re-inserted id after the insert, and finds traces by chat with an index', async () => {
    // AFTER: an insert-or-update that waited for a running deletion inserts only after that
    // wait, past any BEFORE trigger; one connection here cannot race it, so the kind is pinned.
    const definition = await scalar<string>(
      "select pg_get_triggerdef(oid) as value from pg_trigger where tgname='refuse_deleted_company'",
    );
    expect(definition).toContain('AFTER INSERT ON public.companies');
    expect(definition).not.toContain('BEFORE');
    expect(await scalar("select to_regclass('public.traces_conversation')::text as value")).toBe(
      'traces_conversation',
    );
    expect(
      await scalar<string>(
        "select indexdef as value from pg_indexes where indexname='traces_conversation'",
      ),
    ).toContain('(company_id, conversation_id)');
  });

  it('never lets a deleted business be saved back, and leaves every other insert alone', async () => {
    await pause();
    await remove();
    await expect(rpc('save_company_settings', [{ ...A, botEnabled: false }])).rejects.toThrow(
      'This business was deleted and cannot be saved again',
    );
    await expect(
      t.db.query('insert into companies(id,slug,data) values($1,$2,$3)', [
        A.id,
        'other-slug',
        {
          ...A,
          slug: 'other-slug',
        },
      ]),
    ).rejects.toThrow('This business was deleted');
    expect(
      await scalar<number>('select count(*)::int as value from companies where id=$1', [A.id]),
    ).toBe(0);
    // Its rows cannot come back either: they need the business.
    await expect(
      rpc('save_conversation', [createConversation(A.id, nextPhone(), 'whatsapp', now()), 0]),
    ).rejects.toThrow('Unknown company');
    // Other businesses still save, and a new one is created as before.
    await rpc('save_company_settings', [{ ...B, name: 'Bun & Co. renamed' }]);
    const fresh = { ...A, id: randomUUID(), slug: `new-${Date.now()}` };
    await rpc('save_company_settings', [fresh]);
    expect(
      await scalar<number>('select count(*)::int as value from companies where id=$1', [fresh.id]),
    ).toBe(1);
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    await pause();
    for (const signature of [
      'public.delete_company(text,text,text)',
      'public.check_company_deletable(text,text)',
      'public.refuse_deleted_company()',
    ])
      expect(
        await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [role, signature]),
        signature,
      ).toBe(false);
    for (const signature of [
      'public.delete_company(text,text,text)',
      'public.check_company_deletable(text,text)',
    ])
      expect(
        await scalar(`select has_function_privilege('service_role',$1,'EXECUTE') as value`, [
          signature,
        ]),
        signature,
      ).toBe(true);
    await t.db.exec(`set role ${role}`);
    try {
      await expect(remove()).rejects.toThrow(DENIED);
      await expect(check()).rejects.toThrow(DENIED);
      for (const table of ['deleted_companies', 'deleted_whatsapp_connections'])
        await expect(t.db.query(`select * from public.${table}`)).rejects.toThrow(DENIED);
    } finally {
      await t.db.exec('reset role');
    }
    expect(
      await scalar<number>('select count(*)::int as value from companies where id=$1', [A.id]),
    ).toBe(1);
    await t.db.exec('set role service_role');
    try {
      await remove();
      expect(await scalar<number>('select count(*)::int as value from deleted_companies')).toBe(1);
      // What was deleted stays deleted: the backend cannot change or remove it.
      await expect(t.db.query('delete from public.deleted_companies')).rejects.toThrow(DENIED);
      await expect(
        t.db.query("update public.deleted_whatsapp_connections set id='x'"),
      ).rejects.toThrow(DENIED);
    } finally {
      await t.db.exec('reset role');
    }
  });

  it('applies twice without changing anything, and records itself in the ledger once', async () => {
    await pause();
    await remove();
    const snapshot = async () => ({
      functions: (
        await t.db.query(
          `select p.oid::regprocedure::text as signature, md5(p.prosrc) as body, coalesce(p.proacl::text,'') as acl
           from pg_proc p where p.pronamespace='public'::regnamespace order by 1`,
        )
      ).rows,
      deleted: (await t.db.query('select id, deleted_by from deleted_companies')).rows,
      ledger: (
        await t.db.query('select name, applied_at from orderly_schema_migrations where name=$1', [
          FILE,
        ])
      ).rows,
    });
    const before = await snapshot();
    expect(before.ledger).toHaveLength(1);
    await t.db.exec(readFileSync(`supabase/migrations/${FILE}`, 'utf8'));
    expect(await snapshot()).toEqual(before);
    await expect(rpc('save_company_settings', [A])).rejects.toThrow('This business was deleted');
  });

  it('is released as the deployment guide says, and rolls back cleanly (§7c)', async () => {
    const deployment = docs('docs/DEPLOYMENT.md');
    const section = deployment.slice(
      deployment.indexOf('## 7c. Release order (Delete business'),
      deployment.indexOf('## 8. Owner actions'),
    );
    expect(deployment).toContain(`| \`${FILE}\` (Delete business)`);
    const steps = [
      '1. **Backup:**',
      `2. **SQL:** paste \`supabase/migrations/${FILE}\``,
      '3. **Backend:**',
      '4. **Dashboard:**',
      '**Rollback:**',
    ];
    const at = steps.map((step) => section.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(section).not.toContain('git push origin ');
    // The SHA-256 to check in the SQL editor is the file's.
    const sql = readFileSync(`supabase/migrations/${FILE}`, 'utf8').replace(/\r/g, '');
    expect(section).toContain(
      `its SHA-256, with LF line endings, is \`${createHash('sha256').update(sql).digest('hex')}\``,
    );
    // Bot settings changes only the open business: its bot is paused while it is open, and only
    // then is another one opened to delete it.
    const howTo = section.slice(section.indexOf('To delete a business:')).replace(/\s+/g, ' ');
    expect(howTo.indexOf('With the business to delete open, pause its bot')).toBeGreaterThan(0);
    expect(howTo.indexOf('With the business to delete open, pause its bot')).toBeLessThan(
      howTo.indexOf('Then open another business'),
    );
    // What was deleted is copied before the rollback forgets it, both tables of it.
    const begin = section.indexOf('```sql\nbegin;');
    for (const table of ['public.deleted_companies', 'public.deleted_whatsapp_connections']) {
      const copied = section.indexOf(`from ${table} order by deleted_at;`);
      expect(copied, table).toBeGreaterThan(0);
      expect(copied, table).toBeLessThan(begin);
    }
    // The rollback removes all of it and the ledger row, and the file applies again after it.
    const rollback = section.slice(begin + '```sql\n'.length);
    await pause();
    await remove();
    // The audit table outlives every reset: count what this test adds.
    const audited = () =>
      scalar<number>(
        "select count(*)::int as value from audit_events where company_id=$1 and action='admin.workspace_deleted'",
        [A.id],
      );
    const before = await audited();
    const ledger = () =>
      scalar<number>('select count(*)::int as value from orderly_schema_migrations where name=$1', [
        FILE,
      ]);
    try {
      await t.db.exec(rollback.slice(0, rollback.indexOf('```')));
      for (const name of ['public.deleted_companies', 'public.deleted_whatsapp_connections'])
        expect(await scalar('select to_regclass($1)::text as value', [name]), name).toBeNull();
      for (const signature of [
        'public.delete_company(text,text,text)',
        'public.check_company_deletable(text,text)',
        'public.refuse_deleted_company()',
      ])
        expect(
          await scalar('select to_regprocedure($1)::text as value', [signature]),
          signature,
        ).toBeNull();
      expect(
        await scalar("select to_regclass('public.traces_conversation')::text as value"),
      ).toBeNull();
      expect(await ledger()).toBe(0);
      // The audit line stays, and the business can be saved again (nothing remembers it).
      expect(before).toBeGreaterThan(0);
      expect(await audited()).toBe(before);
      await rpc('save_company_settings', [{ ...A, botEnabled: false }]);
    } finally {
      // Applied again, for the tests after this one too.
      await t.db.exec(sql);
    }
    expect(await ledger()).toBe(1);
    await remove();
  });

  it('points the runbook and the gateway guide at the button', () => {
    const runbook = docs('docs/INCIDENT-RUNBOOK.md');
    const deletion = runbook
      .slice(runbook.indexOf('## 6. Delete a workspace on request'))
      .replace(/\s+/g, ' ');
    expect(deletion).toContain(
      '**People** → the card of the business to delete → **Delete business**',
    );
    expect(deletion).toContain("public.delete_company('<id>', '<slug>', '<your auth user id>')");
    expect(deletion).not.toContain('there is no dashboard button');
    const railway = docs('gateway/RAILWAY.md').replace(/\s+/g, ' ');
    expect(railway).toContain(
      'any later event or heartbeat of that session is answered 410, as for a retired one',
    );
  });

  it('stops before anything changes when the deals migration is missing', async () => {
    await t.db.exec('begin');
    try {
      await t.db.exec("delete from orderly_schema_migrations where name='202610210001_deals.sql'");
      await expect(t.db.exec(readFileSync(`supabase/migrations/${FILE}`, 'utf8'))).rejects.toThrow(
        'Apply 202610210001_deals.sql before 202610220001_business_deletion.sql',
      );
    } finally {
      await t.db.exec('rollback');
    }
  });
});
