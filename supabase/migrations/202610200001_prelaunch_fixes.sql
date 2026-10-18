-- Pre-launch fixes: staff email alerts reach the person who asked for them, erasing a customer
-- finds every format of their number and clears their blocked-number label, a customer export
-- finds every chat erasing would remove, automatic order notices no longer hide a customer waiting
-- for staff or restart how long they have waited, a linked phone that stopped working alerts
-- staff, a message that failed for good goes into its chat instead of holding back the customer's
-- later ones, the spam safety net is 1,500 AI replies an hour (100 per customer) with a warning
-- at 80%, the Active orders filter leaves out pending orders, the daily orders chart counts the
-- business's own days, a pipeline health check, a daily purge of old operational rows, and a
-- ledger of applied migrations.
-- Apply after 202610190003_menu_purge_schedule.sql and before deploying the backend that calls
-- orderly_pipeline_health and customer_records. The backend and dashboard running now keep
-- working: every function keeps its signature and result shape (staff_attention only adds a
-- 'whatsapp' count and items), and the only new column has a default.
-- Safe to rerun while no later file redefines these functions. It replaces, starting from their
-- latest bodies: alert_recipient (202609180001), erase_customer and run_retention (202609170001),
-- query_orders and workspace_summary (202609160001), prune_orderly_cron_history (202609110001),
-- and ai_limit_settings, has_overdue_attention, staff_attention and fail_exhausted_orderly_jobs
-- (202610180001). After it, 202610180001 refuses to run again.
set lock_timeout = '5s';

-- Which migrations were applied, and when. Each migration from this one on records itself last.
create table if not exists public.orderly_schema_migrations (
  name text primary key check (name ~ '^[0-9]{12}_[a-z0-9_]+\.sql$'),
  applied_at timestamptz not null default now(),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
);
alter table public.orderly_schema_migrations enable row level security;
revoke all on public.orderly_schema_migrations from public, anon, authenticated;
grant select, insert on public.orderly_schema_migrations to service_role;

-- Latest body from 202609180001_email_alerts.sql. Changed: the address is the requested user's
-- own, not the first subscriber's, so each person gets their own alert and a removed member none.
create or replace function public.alert_recipient(p_company_id text,p_user_id uuid) returns text
language sql stable security definer set search_path=public as $$
  select u.email from auth.users u join alert_subscriptions s on s.user_id=u.id
  where s.company_id=p_company_id and s.user_id=p_user_id and u.id=p_user_id and s.enabled and u.email_confirmed_at is not null
    and (exists(select 1 from company_memberships m where m.company_id=p_company_id and m.user_id=u.id)
      or exists(select 1 from platform_admins a where a.user_id=u.id));
$$;

-- Latest body from 202609170001_retention.sql. Changed:
-- * A whole international number matches every WhatsApp chat with the same digits, so
--   '+92 300 1234567' finds '923001234567' (Cloud API) and '+923001234567' (linked phone). A
--   partial or empty number never matches by digits, so it cannot reach chats whose number is
--   unknown; the exact match stays for anything else.
-- * Jobs are found the same way, and by the erased chats' WhatsApp address and message stream, so
--   messages saved before the number was known are cleared too.
-- * A block of this customer keeps its keys (it still applies) but loses the name and the chat
--   link; receipts of messages never linked to any chat go.
-- * An empty number is refused.
create or replace function public.erase_customer(p_company_id text,p_phone text) returns integer language plpgsql security definer set search_path=public as $$
declare ids text[]; order_ids text[]; addresses jsonb[]; streams text[]; marks text[]; block_ids text[];
  digits text := regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
  by_digits boolean := digits ~ '^[1-9][0-9]{9,14}$';
begin
  perform 1 from companies where id=p_company_id for update;
  if exists(select 1 from companies where id=p_company_id and data->>'botEnabled'='true') or exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) or exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now()) then raise exception 'Pause automation and wait for running work before deleting customer data'; end if;
  if btrim(coalesce(p_phone,''))='' then raise exception 'Customer phone number required'; end if;
  select array_agg(id) into ids from conversations where company_id=p_company_id
    and (customer_phone=p_phone or (by_digits and channel='whatsapp' and regexp_replace(customer_phone,'[^0-9]','','g')=digits));
  select array_agg(id) into order_ids from orders where company_id=p_company_id and conversation_id=any(ids);
  select array_agg(data->'whatsappAddress'),
      array_agg((data->'whatsappAddress'->>'connectionId')||':'||(data->'whatsappAddress'->>'generation')||':'||(data->'whatsappAddress'->>'peer')),
      array_agg(data->'blocked'->>'blockId')
    into addresses, streams, marks from conversations where company_id=p_company_id and id=any(ids);
  -- Before the chats go: the blocks marked on them, pointing at them, or holding this number.
  select array_agg(distinct block_id) into block_ids from blocked_customers where company_id=p_company_id
    and (conversation_id=any(ids) or block_id=any(marks) or (by_digits and key='pn:'||digits));
  -- Keep dedupe tombstones, remove payloads so webhook retries cannot restore deleted data.
  update jobs set status='done',lease_until=null,data=(data-'leaseUntil'-'lastError'-'error')||'{"status":"done","payload":{}}'::jsonb where company_id=p_company_id
    and (data->'payload'->>'phone'=p_phone or (by_digits and regexp_replace(data->'payload'->>'phone','[^0-9]','','g')=digits)
      or data->'payload'->>'conversationId'=any(ids) or data->'payload'->>'orderId'=any(order_ids)
      or data->'payload'->>'streamKey'=any(streams) or data->'payload'->'whatsappAddress'=any(addresses));
  delete from traces where company_id=p_company_id and conversation_id=any(ids);
  update usage_events set data=data-'conversationId' where company_id=p_company_id and data->>'conversationId'=any(ids);
  update blocked_customers set label='Erased customer',conversation_id=null where company_id=p_company_id and block_id=any(block_ids);
  delete from message_deliveries where company_id=p_company_id and conversation_id is null;
  delete from orders where company_id=p_company_id and conversation_id=any(ids);
  delete from conversations where company_id=p_company_id and id=any(ids);
  return coalesce(cardinality(ids),0);
end $$;

-- Latest body from 202609170001_retention.sql. Changed: a chat whose number is unknown ('') no
-- longer matches every other such chat's finished jobs; its jobs are found by its WhatsApp address
-- and message stream instead. A block outlives its chat but no longer points at it.
create or replace function public.run_retention(p_company_id text) returns integer
language plpgsql security definer set search_path=public as $$
declare policy retention_policies; ids text[]; order_ids text[]; phones text[]; addresses jsonb[]; streams text[]; n integer;
begin
  perform 1 from companies where id=p_company_id for update;
  select * into policy from retention_policies where company_id=p_company_id;
  if not found or policy.days=0 or policy.eligible_after is null or policy.eligible_after>now() then return 0; end if;
  update retention_policies set last_attempt_at=now() where company_id=p_company_id;
  -- Skip a busy workspace rather than competing with live processing.
  if exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now())
    or exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) then return 0; end if;
  select array_agg(id) into ids from retention_candidates(p_company_id,policy.days) id;
  select array_agg(id) into order_ids from orders where company_id=p_company_id and conversation_id=any(ids);
  select array_agg(nullif(customer_phone,'')), array_agg(data->'whatsappAddress'),
      array_agg((data->'whatsappAddress'->>'connectionId')||':'||(data->'whatsappAddress'->>'generation')||':'||(data->'whatsappAddress'->>'peer'))
    into phones, addresses, streams from conversations where company_id=p_company_id and id=any(ids);
  -- Keep webhook/job dedupe tombstones, remove their personal data and provider errors.
  update jobs set lease_until=null,data=(data-'leaseUntil'-'lastError'-'error')||'{"payload":{}}'::jsonb
    where company_id=p_company_id and status='done' and
      (data->'payload'->>'conversationId'=any(ids) or data->'payload'->>'phone'=any(phones) or data->'payload'->>'orderId'=any(order_ids)
        or data->'payload'->>'streamKey'=any(streams) or data->'payload'->'whatsappAddress'=any(addresses));
  delete from traces where company_id=p_company_id and conversation_id=any(ids);
  update usage_events set data=data-'conversationId' where company_id=p_company_id and data->>'conversationId'=any(ids);
  update blocked_customers set conversation_id=null where company_id=p_company_id and conversation_id=any(ids);
  delete from orders where company_id=p_company_id and conversation_id=any(ids);
  delete from conversation_locks where company_id=p_company_id and conversation_id=any(ids);
  delete from conversations where company_id=p_company_id and id=any(ids);
  n:=coalesce(cardinality(ids),0);
  update retention_policies set last_run_at=now(),last_deleted=n where company_id=p_company_id;
  if n>0 then perform audit_event(p_company_id,'system','privacy.retention_deleted.'||n); end if;
  return n;
end $$;

-- Whether a chat's last message written by a person is not a staff reply. Automatic notices do
-- not count: anything marked as a notice, and order-status notices saved before they were marked
-- ("Order ORD-1 is now ready."). Usually the last message decides; only a notice there means
-- looking further back.
create or replace function public.awaits_staff_reply(p_messages jsonb) returns boolean
language sql immutable set search_path = public as $$
  select case
    when p_messages->-1->>'notice' is distinct from 'true' and p_messages->-1->>'role' is distinct from 'staff' then true
    else coalesce((
      select m->>'role' from jsonb_array_elements(case when jsonb_typeof(p_messages)='array' then p_messages else '[]'::jsonb end) with ordinality a(m,n)
      where m->>'notice' is distinct from 'true'
        and not (m->>'role'='staff' and coalesce(m->>'text','') ~ '^Order [^ ]+ is now (pending|accepted|preparing|ready|out for delivery|completed|rejected|cancelled)\.$')
      order by n desc limit 1
    ),'') <> 'staff'
  end;
$$;

-- Since when a customer waiting for staff has waited, for the bell and email alerts: their latest
-- message, unless a staff reply came after it. Automatic notices count as nothing, as in
-- awaits_staff_reply, so an order status change no longer restarts the wait. Never later than
-- the chat was last saved; with no such message, when the chat was last saved, as before.
create or replace function public.waiting_since(p_messages jsonb,p_updated_at timestamptz) returns timestamptz
language sql stable set search_path = public as $$
  select least(p_updated_at,(
    select case when m->>'role'='customer' then (m->>'createdAt')::timestamptz end
    from jsonb_array_elements(case when jsonb_typeof(p_messages)='array' then p_messages else '[]'::jsonb end) with ordinality a(m,n)
    where m->>'notice' is distinct from 'true'
      and (m->>'role'='customer' or (m->>'role'='staff'
        and coalesce(m->>'text','') !~ '^Order [^ ]+ is now (pending|accepted|preparing|ready|out for delivery|completed|rejected|cancelled)\.$'))
    order by n desc limit 1));
$$;

-- Keep in step with AI_LIMIT_DEFAULTS and AI_LIMIT_RANGES in src/shared/models.ts. Changed: the
-- defaults are 1,500 replies an hour for the restaurant and 100 for one customer.
create or replace function public.ai_limit_settings(p_data jsonb)
returns table(replies_per_hour integer, replies_per_customer integer)
language sql immutable set search_path = public as $$
  select ai_limit_value(p_data->'aiLimits'->'repliesPerHour', 20, 10000, 1500),
    ai_limit_value(p_data->'aiLimits'->'repliesPerCustomerPerHour', 5, 1000, 100);
$$;

-- 80% of this clock hour's AI replies are used and the hourly limit has not been reached in this
-- hour yet (once it has, the reached limit is shown instead).
create or replace function public.ai_hourly_warning(p_company_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from companies c, ai_limit_settings(c.data) s where c.id=p_company_id
    and ai_replies_this_hour(p_company_id) >= ceil(s.replies_per_hour*0.8)
    and not exists(select 1 from ai_limit_hits h where h.company_id=p_company_id and h.scope='hourly'
      and h.window_key=to_char(date_trunc('hour',now() at time zone 'UTC'),'YYYY-MM-DD"T"HH24')));
$$;

-- A linked phone that stopped working while its business's bot is on, so customers get no
-- replies: logged out or failed, connected but silent for over 3 minutes (GATEWAY_HEARTBEAT_STALE_MS
-- in src/shared/whatsapp.ts), or still reconnecting p_minutes after it went down (downSince; the
-- last change for a connection saved before downSince existed). Only a phone that was paired (its
-- account is known), so a pairing in progress is not an alert. down_at: when it stopped working.
create or replace function public.whatsapp_down(p_company_id text,p_minutes integer)
returns table(id text,down_at timestamptz)
language sql stable security definer set search_path=public as $$
  select w.id, case when w.data->>'status'='connected'
      then coalesce((w.data->>'lastHeartbeatAt')::timestamptz,(w.data->>'updatedAt')::timestamptz)
      else coalesce((w.data->>'downSince')::timestamptz,(w.data->>'updatedAt')::timestamptz) end
  from whatsapp_connections w join companies c on c.id=w.company_id
  where w.company_id=p_company_id and w.data->>'provider'='baileys' and c.data->>'botEnabled'='true'
    and nullif(w.data->>'accountJid','') is not null
    and (w.data->>'status' in ('error','logged_out')
      or (w.data->>'status'='connected'
        and coalesce((w.data->>'lastHeartbeatAt')::timestamptz,'-infinity')<now()-interval '180 seconds')
      or (w.data->>'status' in ('reconnecting','connecting')
        and coalesce((w.data->>'downSince')::timestamptz,(w.data->>'updatedAt')::timestamptz)<now()-make_interval(mins=>p_minutes)));
$$;

-- Latest body from 202610180001_spam_protection.sql. Changed: an automatic notice is not a staff
-- reply, a customer has waited since their message (waiting_since), an order waiting 15 minutes
-- counts whatever the alert delay, the 80% warning counts, and so does a linked phone that
-- stopped working (one still reconnecting after the alert delay).
create or replace function public.has_overdue_attention(p_company_id text,p_minutes integer) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from orders where company_id=p_company_id and data->>'status'='pending' and data->>'sandbox'='false' and created_at<now()-make_interval(mins=>least(p_minutes,15)))
    or exists(select 1 from conversations where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human' and awaits_staff_reply(data->'messages') and jsonb_typeof(data->'blocked') is distinct from 'object' and waiting_since(data->'messages',updated_at)<now()-make_interval(mins=>p_minutes))
    or exists(select 1 from jobs where company_id=p_company_id and status='failed' and data->>'kind'<>'staff_alert' and created_at<now()-make_interval(mins=>p_minutes))
    or company_budget_warning(p_company_id)
    or exists(select 1 from ai_limit_hits where company_id=p_company_id and last_hit_at>now()-interval '1 hour')
    or ai_hourly_warning(p_company_id)
    or exists(select 1 from whatsapp_down(p_company_id,p_minutes));
$$;
-- Latest body from 202610180001_spam_protection.sql. Changed: an automatic notice is not a staff
-- reply, a waiting customer's item is dated from their message (waiting_since) as email alerts
-- count it, and the 80% warning is a 'limit' item with scope 'hourly_near' (dashboards that do not
-- know it show "AI limit reached"). It is not counted in "limits", which are limits reached. A
-- linked phone that stopped working is a 'whatsapp' item (counted in "whatsapp"; dashboards that do
-- not know it show "Something needs attention"); one reconnecting shows after 3 minutes, when
-- Agent flow calls it offline.
create or replace function public.staff_attention(p_company_id text) returns jsonb
language sql stable security definer set search_path=public as $$
  with limits as (
    select h.scope,h.window_key,h.first_hit_at,h.resets_at from ai_limit_hits h join companies c on c.id=h.company_id
    where h.company_id=p_company_id and h.resets_at>now()
      and case h.scope
        when 'monthly' then case when jsonb_typeof(c.data->'ai'->'monthlyBudgetUsd')='number'
          then h.limit_value>=(c.data->'ai'->>'monthlyBudgetUsd')::numeric else true end
        when 'hourly' then h.limit_value>=(select s.replies_per_hour from ai_limit_settings(c.data) s)
        else false end
  ), alerts as (
    select 'order:'||id as id,'order'::text as kind,id as "entityId",created_at as "createdAt",null::text as scope,null::timestamptz as "resetsAt"
      from orders where company_id=p_company_id and data->>'status'='pending' and data->>'sandbox'='false'
    union all
    select 'handoff:'||id,'handoff',id,waiting_since(data->'messages',updated_at),null,null from conversations
      where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human' and awaits_staff_reply(data->'messages')
        and jsonb_typeof(data->'blocked') is distinct from 'object'
    union all
    select 'job:'||id,'job',id,created_at,null,null from jobs
      where company_id=p_company_id and status='failed'
    union all
    select 'budget:'||p_company_id||':'||to_char(now() at time zone 'UTC','YYYY-MM'),'budget',p_company_id,date_trunc('month',now()),null,null
      where company_budget_warning(p_company_id) and not exists(select 1 from limits where scope='monthly')
    union all
    select 'limit:'||scope||':'||window_key,'limit',p_company_id,first_hit_at,scope,resets_at from limits
    union all
    select 'limit:hourly_near:'||to_char(date_trunc('hour',now() at time zone 'UTC'),'YYYY-MM-DD"T"HH24'),'limit',p_company_id,
      date_trunc('hour',now() at time zone 'UTC') at time zone 'UTC','hourly_near',(date_trunc('hour',now() at time zone 'UTC') at time zone 'UTC')+interval '1 hour'
      where ai_hourly_warning(p_company_id)
    union all
    select 'whatsapp:'||id,'whatsapp',id,down_at,null,null from whatsapp_down(p_company_id,3)
  )
  select jsonb_build_object('total',(select count(*) from alerts),
    'orders',(select count(*) from alerts where kind='order'),
    'handoffs',(select count(*) from alerts where kind='handoff'),
    'failures',(select count(*) from alerts where kind='job'),
    'budgets',(select count(*) from alerts where kind='budget'),
    'limits',(select count(*) from alerts where kind='limit' and scope<>'hourly_near'),
    'whatsapp',(select count(*) from alerts where kind='whatsapp'),
    'items',coalesce((select jsonb_agg(jsonb_strip_nulls(to_jsonb(a))) from (select * from alerts order by "createdAt" desc,id limit 30) a),'[]'::jsonb));
$$;

-- What erase_customer would remove for this number, for a complete customer export: every chat
-- it matches (the same rule: the exact text in any chat, and every WhatsApp format of a whole
-- international number) and the orders placed in them. Newest first, at most 200 chats.
create or replace function public.customer_records(p_company_id text,p_phone text) returns jsonb
language sql stable security definer set search_path=public as $$
  with matched as (
    select c.id, c.data, c.updated_at from conversations c,
      (select regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') digits) p
    where c.company_id=p_company_id and btrim(coalesce(p_phone,''))<>''
      and (c.customer_phone=p_phone or (p.digits ~ '^[1-9][0-9]{9,14}$' and c.channel='whatsapp'
        and regexp_replace(c.customer_phone,'[^0-9]','','g')=p.digits))
    order by c.updated_at desc, c.id limit 200
  )
  select jsonb_build_object(
    'conversations',coalesce((select jsonb_agg(data order by updated_at desc, id) from matched),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(o.data order by o.created_at desc, o.id) from orders o
      where o.company_id=p_company_id and o.conversation_id in (select id from matched)),'[]'::jsonb));
$$;

-- Latest body from 202609160001_launch_hardening.sql. Changed: 'active' is the orders staff are
-- working on (accepted, preparing, ready or out for delivery), as the Orders page shows them
-- beside its own Pending tab and the local store counts them; pending orders are not in it.
create or replace function public.query_orders(p_company_id text,p_filter jsonb) returns jsonb language sql stable security definer set search_path=public as $$
  with opts as (select greatest(1,least(100,coalesce((p_filter->>'pageSize')::integer,50))) size,greatest(1,coalesce((p_filter->>'page')::integer,1)) page),
  matching as (select o.* from orders o join conversations c on c.id=o.conversation_id and c.company_id=o.company_id where o.company_id=p_company_id
    and (not p_filter ? 'sandbox' or (c.channel='demo')=(p_filter->>'sandbox')::boolean)
    and (coalesce(p_filter->>'status','all')='all' or o.data->>'status'=p_filter->>'status' or (p_filter->>'status'='active' and o.data->>'status' in ('accepted','preparing','ready','out_for_delivery')))
    and (coalesce(p_filter->>'search','')='' or strpos(lower(concat_ws(' ',o.data->>'reference',o.data->>'customerName',o.data->>'customerPhone')),lower(p_filter->>'search'))>0)
    and (not p_filter ? 'from' or o.created_at>=(p_filter->>'from')::timestamptz) and (not p_filter ? 'to' or o.created_at<=(p_filter->>'to')::timestamptz)),
  page_rows as (select data from matching order by created_at desc,id desc limit (select size from opts) offset (select (page-1)*size from opts))
  select jsonb_build_object('items',coalesce((select jsonb_agg(data) from page_rows),'[]'),'total',(select count(*) from matching),'page',page,'pageSize',size) from opts;
$$;

-- A business's time zone (companies.data->>'timezone'), for counting its orders by its own days:
-- a zone name such as 'Asia/Karachi', or UTC. Anything else means Asia/Karachi, so a bad setting
-- never breaks the Overview: a missing zone, an offset or a POSIX rule (Postgres reads '+05:00'
-- and 'UTC+5' as 5 hours west of UTC), an abbreviation, and a name Postgres does not know.
create or replace function public.business_time_zone(p_data jsonb) returns text
language plpgsql stable set search_path = public as $$
declare zone text := p_data->>'timezone';
begin
  if coalesce(zone,'') !~ '^(UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z][A-Za-z0-9_+-]*)+)$' then return 'Asia/Karachi'; end if;
  perform now() at time zone zone;
  return zone;
exception when others then return 'Asia/Karachi';
end $$;

-- Latest body from 202609160001_launch_hardening.sql. Changed: the daily counts are the business's
-- own days (business_time_zone), as the Overview chart labels them, not UTC days, so an order at
-- 00:30 in Karachi counts on that day, not the day before. Oldest first, today last, as before.
create or replace function public.workspace_summary(p_company_id text,p_sandbox boolean) returns jsonb language sql stable security definer set search_path=public as $$
  with zone as (select business_time_zone((select data from companies where id=p_company_id)) tz),
  conv as (select * from conversations where company_id=p_company_id and (channel='demo')=p_sandbox),
  ord as (select o.*,(o.created_at at time zone (select tz from zone))::date as local_day from orders o join conv c on c.id=o.conversation_id where o.company_id=p_company_id),
  days as (select (now() at time zone (select tz from zone))::date-i as day_date from generate_series(0,29) i)
  select jsonb_build_object('orders',(select count(*) from ord),'pending',(select count(*) from ord where data->>'status'='pending'),'value',(select coalesce(sum((data->>'total')::numeric),0) from ord where data->>'status' not in ('cancelled','rejected')),'conversations',(select count(*) from conv),'needsStaff',(select count(*) from conv where data->>'mode'='human'),'monthlySpend',(select coalesce(sum(cost_usd),0) from usage_events where company_id=p_company_id and created_at>=date_trunc('month',now())),
    'daily',(select jsonb_agg(jsonb_build_object('date',day_date,'count',(select count(*) from ord where local_day=day_date)) order by day_date) from days));
$$;

-- Latest body from 202610180001_spam_protection.sql. Changed, as the worker does since these
-- fixes: an incoming message that failed for good goes into its chat (unless it is there already)
-- and the chat goes to staff, then the job ends as done with payload.failedPermanently, so the
-- customer's later messages are no longer held back behind it. A message whose chat does not
-- exist or is blocked keeps its job failed, as before.
create or replace function public.fail_exhausted_orderly_jobs(p_limit integer default 20) returns integer
language plpgsql security definer set search_path = '' as $$
declare target record; failed_conversation_id text; trace_id text; affected integer := 0;
  conversation_blocked boolean; message_id text; echo boolean; present boolean; released boolean;
  failed_at timestamptz := now();
  stamp text := to_char(failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  failure_message text := 'Worker stopped after the retry limit. Review this job before retrying.';
begin
  for target in
    select j.* from public.jobs j
    where j.attempts >= 5 and (
      j.status = 'pending' or
      (j.status = 'processing' and (j.lease_until is null or j.lease_until <= failed_at))
    )
    order by j.arrival_sequence
    limit least(greatest(coalesce(p_limit, 20), 0), 20)
    for update of j skip locked
  loop
    failed_conversation_id := null;
    conversation_blocked := false;
    released := false;
    if target.data->>'kind' = 'incoming' then
      if target.data->'payload' ? 'whatsappAddress' then
        select c.id, jsonb_typeof(c.data->'blocked') = 'object' into failed_conversation_id, conversation_blocked
          from public.conversations c
          where c.company_id = target.company_id and c.channel = 'whatsapp'
            and c.data->'whatsappAddress' = target.data->'payload'->'whatsappAddress'
          for update of c;
      else
        select c.id, jsonb_typeof(c.data->'blocked') = 'object' into failed_conversation_id, conversation_blocked
          from public.conversations c
          where c.company_id = target.company_id and c.channel = 'whatsapp'
            and c.customer_phone = target.data->'payload'->>'phone'
          for update of c;
      end if;
      message_id := target.data->'payload'->>'messageId';
      echo := coalesce(target.data->'payload'->>'echo', '') = 'true';
      released := failed_conversation_id is not null and not coalesce(conversation_blocked, false)
        and message_id is not null;
      present := released and exists (select 1 from public.conversation_messages m
        where m.company_id = target.company_id and m.conversation_id = failed_conversation_id and m.id = message_id);
      -- Preserve every other field and advance both representations of version. A customer's
      -- message also reopens the reply window, as when it is processed.
      update public.conversations c set version = c.version + 1, updated_at = failed_at,
        data = (c.data - 'botPausedAt' - 'limitPause') || jsonb_build_object('mode', 'human', 'version', c.version + 1,
          'updatedAt', stamp)
          || case when released and not present then jsonb_build_object('messages',
              coalesce(c.data->'messages', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('id', message_id,
                'role', case when echo then 'staff' else 'customer' end,
                'text', left(coalesce(target.data->'payload'->>'text', ''), 4000),
                'createdAt', coalesce(target.data->'createdAt', to_jsonb(stamp)))))
            else '{}'::jsonb end
          || case when released and not present and not echo
              and coalesce(c.data->>'lastInboundAt', '') < coalesce(target.data->>'createdAt', '')
            then jsonb_build_object('lastInboundAt', target.data->'createdAt') else '{}'::jsonb end
        where c.id = failed_conversation_id and c.company_id = target.company_id
          and (c.data->>'mode' = 'bot' or c.data ? 'botPausedAt' or c.data ? 'limitPause' or (released and not present))
          and jsonb_typeof(c.data->'blocked') is distinct from 'object';
    elsif target.data->>'kind' = 'sheet_sync' then
      -- A newer order revision/job or a successful write owns its own sync state.
      update public.orders o set data = o.data || '{"syncStatus":"failed"}'::jsonb
        where o.id = target.data->'payload'->>'orderId' and o.company_id = target.company_id
          and o.updated_at <= target.created_at and o.data->>'syncStatus' = 'pending'
          and not exists (
            select 1 from public.jobs later where later.company_id = target.company_id
              and later.data->>'kind' = 'sheet_sync'
              and later.data->'payload'->>'orderId' = o.id
              and later.arrival_sequence > target.arrival_sequence
          );
    elsif target.data->>'kind' = 'whatsapp_send'
      and target.data->'payload'->>'messageId' is not null
      and target.data->'payload'->>'externalId' is null then
      -- Same 'job:' key as the worker's own note; a real receipt outranks it.
      begin
        perform public.record_delivery(target.company_id, 'job:' || target.id, 'failed',
          target.data->'payload'->>'conversationId', target.data->'payload'->>'messageId',
          'Not sent: sending stopped after repeated failures. Check the WhatsApp connection.');
      exception when others then
        -- A deleted conversation must not stop the remaining jobs from being finished.
        raise warning 'Orderly could not record an unsent reply';
      end;
    end if;
    if released then
      update public.jobs set status = 'done', lease_until = null,
        data = (data - 'leaseUntil') || jsonb_build_object('status', 'done',
          'error', 'Worker stopped after the retry limit. The message is in the chat for staff.',
          'payload', coalesce(data->'payload', '{}'::jsonb) || '{"failedPermanently":true}'::jsonb)
        where id = target.id;
    else
      update public.jobs set status = 'failed', lease_until = null,
        data = (data - 'leaseUntil') || jsonb_build_object('status', 'failed', 'error', failure_message)
        where id = target.id;
    end if;
    trace_id := gen_random_uuid()::text;
    insert into public.traces(id, company_id, conversation_id, created_at, data)
      values (trace_id, target.company_id, failed_conversation_id, failed_at,
        jsonb_strip_nulls(jsonb_build_object('id', trace_id, 'companyId', target.company_id,
          'conversationId', failed_conversation_id, 'action', 'job.failed',
          'detail', 'Job ' || target.id || case when released
            then ' stopped after the retry limit. Its message is in the chat for staff.'
            else ' stopped after the retry limit. Review saved work before retrying.' end,
          'createdAt', stamp)));
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- Whether saved work is being processed, for an outside monitor (through the server only).
-- 'stalled': a job due more than 3 minutes ago (or whose worker lease ran out 3 minutes ago) that
-- recovery would still send, not counting messages held behind a customer's failed message (those
-- already show as failed jobs). 'unconfigured': the worker address and token or the minute's
-- recovery are not set up, so nothing is sent. Worker errors are read from pg_net's responses,
-- which come only from dispatch_orderly_job (its sole caller of net.http_post).
create or replace function public.orderly_pipeline_health() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare scheduler jsonb; stalled integer; oldest timestamptz; last_run jsonb; worker_errors integer; health text;
begin
  scheduler := public.orderly_scheduler_status();
  select count(*)::integer, min(j.next_run_at) into stalled, oldest from public.jobs j
  where j.attempts < 5
    and ((j.status = 'pending' and j.next_run_at < now() - interval '3 minutes')
      or (j.status = 'processing' and coalesce(j.lease_until, j.next_run_at) < now() - interval '3 minutes'))
    and (j.data->>'kind' is distinct from 'incoming' or not exists (
      select 1 from public.jobs earlier where earlier.company_id = j.company_id
        and earlier.data->>'kind' = 'incoming' and earlier.status = 'failed'
        and coalesce(earlier.data->'payload'->>'streamKey', earlier.data->'payload'->>'phone')
          is not distinct from coalesce(j.data->'payload'->>'streamKey', j.data->'payload'->>'phone')
        and earlier.arrival_sequence < j.arrival_sequence));
  begin
    select jsonb_build_object('status', d.status,
        'at', to_char(d.end_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      into last_run from cron.job_run_details d join cron.job s using (jobid)
      where s.jobname = 'orderly-recover-jobs' and d.end_time is not null
      order by d.end_time desc limit 1;
  exception when others then last_run := null;
  end;
  begin
    select count(*)::integer into worker_errors from net._http_response r
      where r.created > now() - interval '15 minutes'
        and (r.timed_out or r.error_msg is not null or r.status_code is null or r.status_code not between 200 and 299);
  exception when others then worker_errors := null;
  end;
  health := case
    when not coalesce((scheduler->>'configured')::boolean, false)
      or not coalesce((scheduler->>'recoveryScheduled')::boolean, false) then 'unconfigured'
    when stalled > 0 then 'stalled'
    else 'ok' end;
  return jsonb_build_object('status', health, 'stalledJobs', stalled,
    'oldestDueAt', to_char(oldest at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'schedulerConfigured', coalesce((scheduler->>'configured')::boolean, false),
    'recoveryScheduled', coalesce((scheduler->>'recoveryScheduled')::boolean, false),
    'lastRecoverRun', last_run, 'recentWorkerErrors', worker_errors,
    'dbSizeBytes', pg_database_size(current_database()));
end;
$$;

-- When a receipt row was first written, so receipts never linked to a chat can be purged by age.
-- Existing rows get the time this runs. record_delivery inserts by position and is unaffected.
alter table public.message_deliveries add column if not exists created_at timestamptz not null default now();
create index if not exists traces_created on public.traces(created_at);
create index if not exists jobs_done_payload on public.jobs(created_at) where status = 'done' and data->'payload' <> '{}'::jsonb;
create index if not exists message_deliveries_unlinked on public.message_deliveries(created_at) where conversation_id is null;

-- Keeps operational rows from filling the database (500 MB on the Free plan): traces older than
-- 90 days (audit events are a separate table and stay), the content of finished jobs older than
-- 14 days (the job and its duplicate key stay, so a late webhook retry is still recognised, and
-- its status does not change), and receipts never linked to a chat, older than 90 days. At most
-- p_batch rows of each per statement and four statements per table per run, so a run stays short;
-- a backlog clears over a few days. Scheduled daily below.
create or replace function public.purge_orderly_operations(p_batch integer default 5000) returns integer
language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare batch integer := least(greatest(coalesce(p_batch, 5000), 1), 10000); n integer; total integer := 0;
begin
  for i in 1..4 loop
    delete from traces where id in (
      select id from traces where created_at < now() - interval '90 days' order by created_at limit batch);
    get diagnostics n = row_count; total := total + n;
    exit when n < batch;
  end loop;
  for i in 1..4 loop
    update jobs set data = (data - 'leaseUntil' - 'lastError' - 'error') || '{"payload":{}}'::jsonb
      where id in (select id from jobs where status = 'done' and data->'payload' <> '{}'::jsonb
        and created_at < now() - interval '14 days' order by created_at limit batch);
    get diagnostics n = row_count; total := total + n;
    exit when n < batch;
  end loop;
  for i in 1..4 loop
    delete from message_deliveries where (company_id, external_id) in (
      select company_id, external_id from message_deliveries
      where conversation_id is null and created_at < now() - interval '90 days' order by created_at limit batch);
    get diagnostics n = row_count; total := total + n;
    exit when n < batch;
  end loop;
  return total;
end $$;

-- Latest body from 202609110001_job_dispatch.sql. Changed: covers every Orderly schedule (the
-- retention, alert, menu and purge jobs' history was never pruned), not only the two first ones.
create or replace function public.prune_orderly_cron_history() returns integer
language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  delete from cron.job_run_details where runid in (
    select details.runid from cron.job_run_details details join cron.job scheduled using (jobid)
    where scheduled.jobname like 'orderly-%'
      and details.end_time < now() - interval '3 days'
    order by details.end_time limit 10000
  );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname=any(array['alert_recipient','erase_customer','run_retention','awaits_staff_reply','waiting_since',
      'ai_limit_settings','ai_hourly_warning','whatsapp_down','has_overdue_attention','staff_attention',
      'customer_records','query_orders','business_time_zone','workspace_summary','fail_exhausted_orderly_jobs',
      'orderly_pipeline_health','purge_orderly_operations','prune_orderly_cron_history']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- 05:41 in Pakistan (00:41 UTC), when restaurants are closed. A named schedule is updated on a rerun.
select cron.schedule('orderly-ops-purge', '41 0 * * *', 'select public.purge_orderly_operations()');

insert into public.orderly_schema_migrations(name) values ('202610200001_prelaunch_fixes.sql')
  on conflict (name) do nothing;
notify pgrst, 'reload schema';
