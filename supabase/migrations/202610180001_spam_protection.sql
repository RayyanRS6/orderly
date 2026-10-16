-- Spam protection: AI replies per hour for the restaurant and per customer, alerts when an AI
-- limit is reached, and blocked numbers. Apply after 202610170001_business_keys_only.sql and
-- before deploying the code that calls reserve_ai_call. reserve_budget stays as it is for the
-- code still running until then. Safe to rerun.
set lock_timeout = '5s';

-- One limit value from a business's settings. Anything that is not a whole number in range
-- uses the default, so a bad setting can never break AI calls or alerts.
create or replace function public.ai_limit_value(p_value jsonb, p_min integer, p_max integer, p_default integer)
returns integer language plpgsql immutable set search_path = public as $$
declare n numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return p_default; end if;
  n := (p_value #>> '{}')::numeric;
  if n <> trunc(n) or n < p_min or n > p_max then return p_default; end if;
  return n::integer;
end $$;
-- Keep in step with AI_LIMIT_DEFAULTS and AI_LIMIT_RANGES in src/shared/models.ts.
create or replace function public.ai_limit_settings(p_data jsonb)
returns table(replies_per_hour integer, replies_per_customer integer)
language sql immutable set search_path = public as $$
  select ai_limit_value(p_data->'aiLimits'->'repliesPerHour', 20, 10000, 300),
    ai_limit_value(p_data->'aiLimits'->'repliesPerCustomerPerHour', 5, 1000, 30);
$$;

-- One row per reached limit and window: the bell shows it until the window ends or the limit is
-- raised, and an email alert goes out (to subscribers) within the hour.
create table if not exists public.ai_limit_hits (
  company_id text not null references public.companies(id) on delete cascade,
  scope text not null check (scope in ('monthly', 'hourly')),
  window_key text not null,
  limit_value numeric not null,
  resets_at timestamptz not null,
  first_hit_at timestamptz not null default now(),
  last_hit_at timestamptz not null default now(),
  primary key (company_id, scope, window_key)
);
create index if not exists ai_limit_hits_recent on public.ai_limit_hits(company_id, last_hit_at desc);
alter table public.ai_limit_hits enable row level security;
revoke all on public.ai_limit_hits from public, anon, authenticated;
grant all on public.ai_limit_hits to service_role;

create or replace function public.record_ai_limit_hit(p_company_id text, p_scope text, p_window_key text, p_limit numeric, p_resets_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from ai_limit_hits where company_id = p_company_id and resets_at < now() - interval '40 days';
  insert into ai_limit_hits(company_id, scope, window_key, limit_value, resets_at)
    values (p_company_id, p_scope, p_window_key, p_limit, p_resets_at)
    on conflict (company_id, scope, window_key) do update
      set limit_value = excluded.limit_value, resets_at = greatest(ai_limit_hits.resets_at, excluded.resets_at),
        last_hit_at = now();
end $$;

-- Marks a hold made for a live customer chat, so the hourly limit counts calls still running:
-- many numbers writing at once must not all see the same count. reserve_budget leaves it false.
alter table public.budget_reservations add column if not exists live boolean not null default false;

-- Live AI replies this clock hour: settled usage that cost something (a call the provider
-- refused at $0 is not counted), plus live calls still running.
create or replace function public.ai_replies_this_hour(p_company_id text) returns integer
language sql stable security definer set search_path = public as $$
  select ((select count(*) from usage_events where company_id = p_company_id
      and created_at >= date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC'
      and cost_usd > 0 and data->>'sandbox' is distinct from 'true')
    + (select count(*) from budget_reservations where company_id = p_company_id and live
      and settled_at is null and expires_at > now()
      and created_at >= date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC'))::integer;
$$;

-- reserve_budget plus the spam limits, with the reason a call was refused. The limits apply
-- only to live customer chats (p_conversation_id set); tests and model checks keep only the
-- monthly budget. p_customer_since is when the bot last took the chat back. One customer's
-- turns never overlap, so their own count needs only settled usage.
create or replace function public.reserve_ai_call(p_company_id text, p_reservation_id text, p_amount_usd numeric,
  p_expires_at timestamptz, p_conversation_id text default null, p_customer_since timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare company_data jsonb; budget numeric; spent numeric; reserved numeric; per_hour integer; per_customer integer;
  used integer; since timestamptz;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  hour_start timestamptz := date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_amount_usd < 0 or p_amount_usd is null or p_amount_usd in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) or p_expires_at <= now() or p_expires_at is null then raise exception 'Invalid budget reservation'; end if;
  select data into company_data from companies where id = p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  budget := (company_data->'ai'->>'monthlyBudgetUsd')::numeric;
  if budget is null or budget < 0 then raise exception 'Invalid company budget'; end if;
  if exists(select 1 from budget_reservations where id = p_reservation_id) or exists(select 1 from usage_events where id = p_reservation_id) then
    return jsonb_build_object('ok', false, 'limit', 'duplicate');
  end if;
  select coalesce(sum(cost_usd),0) into spent from usage_events where company_id = p_company_id and created_at >= month_start and created_at < month_start + interval '1 month';
  -- A killed function may still have incurred upstream charges. Never silently release its hold.
  select coalesce(sum(amount_usd),0) into reserved from budget_reservations where company_id = p_company_id and settled_at is null and created_at >= month_start and created_at < month_start + interval '1 month';
  if spent + reserved + p_amount_usd > budget then
    perform record_ai_limit_hit(p_company_id, 'monthly', to_char(month_start at time zone 'UTC', 'YYYY-MM'), budget, month_start + interval '1 month');
    return jsonb_build_object('ok', false, 'limit', 'monthly', 'limitValue', budget,
      'resetAt', to_char((month_start + interval '1 month') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;
  if p_conversation_id is not null then
    select s.replies_per_hour, s.replies_per_customer into per_hour, per_customer from ai_limit_settings(company_data) s;
    used := ai_replies_this_hour(p_company_id);
    if used >= per_hour then
      perform record_ai_limit_hit(p_company_id, 'hourly', to_char(hour_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24'), per_hour, hour_start + interval '1 hour');
      return jsonb_build_object('ok', false, 'limit', 'hourly', 'limitValue', per_hour,
        'resetAt', to_char((hour_start + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
    since := greatest(now() - interval '1 hour', least(coalesce(p_customer_since, '-infinity'::timestamptz), now()));
    select count(*) into used from usage_events where company_id = p_company_id and created_at >= since
      and cost_usd > 0 and data->>'sandbox' is distinct from 'true' and data->>'conversationId' = p_conversation_id;
    if used >= per_customer then
      return jsonb_build_object('ok', false, 'limit', 'customer', 'limitValue', per_customer,
        'resetAt', to_char((now() + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
  end if;
  insert into budget_reservations(id, company_id, amount_usd, expires_at, live)
    values (p_reservation_id, p_company_id, p_amount_usd, p_expires_at, p_conversation_id is not null);
  return jsonb_build_object('ok', true);
end $$;

-- For Bot settings: how many live AI replies this clock hour, and the limits in force.
create or replace function public.ai_limit_status(p_company_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'repliesThisHour', ai_replies_this_hour(p_company_id),
    'repliesPerHour', s.replies_per_hour, 'repliesPerCustomerPerHour', s.replies_per_customer,
    'hourResetsAt', to_char(date_trunc('hour', now() at time zone 'UTC') + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  from companies c, ai_limit_settings(c.data) s where c.id = p_company_id;
$$;

-- Blocked numbers. A block keeps every identity known for the customer ('pn:<phone digits>' or
-- 'lid:<WhatsApp privacy ID>'), so it outlasts a reconnect. Rows with the same block_id are one block.
create table if not exists public.blocked_customers (
  company_id text not null references public.companies(id) on delete cascade,
  key text not null check (key ~ '^(pn|lid):[0-9]{5,20}$'),
  block_id text not null,
  label text not null default '' check (length(label) <= 200),
  conversation_id text,
  blocked_by text,
  created_at timestamptz not null default now(),
  blocked_count integer not null default 0,
  last_blocked_at timestamptz,
  primary key (company_id, key)
);
create index if not exists blocked_customers_block on public.blocked_customers(company_id, block_id);
alter table public.blocked_customers enable row level security;
revoke all on public.blocked_customers from public, anon, authenticated;
grant all on public.blocked_customers to service_role;

-- Blocks the keys and marks the conversation in one transaction. The chat leaves "Needs staff"
-- (no message will arrive to answer) and any pause mark goes, so nothing resumes it later.
-- One person has one block: a block that already holds one of these identities (from another
-- chat of the same customer) takes this chat's keys, and every block sharing them is merged, so
-- unblocking from any of the person's chats unblocks the person.
create or replace function public.block_customer(p_company_id text, p_conversation_id text, p_block_id text,
  p_keys text[], p_label text, p_actor_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; conv conversations%rowtype; marked jsonb; target text; merged text[];
  stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_block_id is null or p_block_id = '' or p_keys is null or cardinality(p_keys) = 0 then raise exception 'Nothing to block'; end if;
  foreach k in array p_keys loop
    if k is null or k !~ '^(pn|lid):[0-9]{5,20}$' then raise exception 'Invalid block key'; end if;
  end loop;
  perform 1 from companies where id = p_company_id for update;
  select * into conv from conversations where company_id = p_company_id and id = p_conversation_id for update;
  if not found then raise exception 'Unknown conversation'; end if;
  if conv.channel <> 'whatsapp' then raise exception 'Only WhatsApp chats can be blocked'; end if;
  if jsonb_typeof(conv.data->'blocked') = 'object' then return conv.data; end if;
  select array_agg(distinct block_id) into merged from blocked_customers where company_id = p_company_id and key = any(p_keys);
  select block_id into target from blocked_customers where company_id = p_company_id and key = any(p_keys)
    order by created_at desc, key limit 1;
  target := coalesce(target, p_block_id);
  if merged is not null then
    update blocked_customers set block_id = target where company_id = p_company_id and block_id = any(merged) and block_id <> target;
    update conversations c set version = c.version + 1, updated_at = now(),
      data = jsonb_set(c.data, '{blocked,blockId}', to_jsonb(target)) || jsonb_build_object('version', c.version + 1, 'updatedAt', stamp)
      where c.company_id = p_company_id and c.data->'blocked'->>'blockId' = any(merged) and c.data->'blocked'->>'blockId' <> target;
  end if;
  insert into blocked_customers(company_id, key, block_id, label, conversation_id, blocked_by)
    select p_company_id, key, target, left(coalesce(p_label, ''), 200), p_conversation_id, p_actor_id
    from (select distinct unnest(p_keys) as key) keys
    on conflict (company_id, key) do nothing;
  marked := (conv.data - 'botPausedAt' - 'limitPause') || jsonb_build_object(
    'blocked', jsonb_build_object('at', stamp, 'blockId', target),
    'mode', 'bot', 'version', conv.version + 1, 'updatedAt', stamp);
  update conversations set data = marked, version = conv.version + 1, updated_at = now()
    where company_id = p_company_id and id = p_conversation_id;
  return marked;
end $$;

-- Removes the block and the mark on its conversations, including marks left behind when a
-- later block of the same person took over its keys. False when there was nothing to remove.
create or replace function public.unblock_customer(p_company_id text, p_block_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare removed integer; cleared integer;
  stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  perform 1 from companies where id = p_company_id for update;
  delete from blocked_customers where company_id = p_company_id and block_id = p_block_id;
  get diagnostics removed = row_count;
  update conversations c set version = c.version + 1, updated_at = now(),
    data = (c.data - 'blocked') || jsonb_build_object('version', c.version + 1, 'updatedAt', stamp)
    where c.company_id = p_company_id and jsonb_typeof(c.data->'blocked') = 'object'
      and not exists(select 1 from blocked_customers b where b.company_id = p_company_id and b.block_id = c.data->'blocked'->>'blockId');
  get diagnostics cleared = row_count;
  return removed > 0 or cleared > 0;
end $$;

-- The block matching any of the message's keys, or null. Counts the ignored message and records
-- any identity the block did not know yet (a phone number shared after a privacy ID).
create or replace function public.blocked_customer_hit(p_company_id text, p_keys text[])
returns text language plpgsql security definer set search_path = public as $$
declare matched blocked_customers%rowtype;
begin
  if p_keys is null or cardinality(p_keys) = 0 then return null; end if;
  -- Wait for a block or unblock in progress (they lock the company row for update), so an
  -- unblock that is committing cannot be undone by a message arriving at the same moment.
  -- Hits do not wait for each other.
  perform 1 from companies where id = p_company_id for key share;
  if not found then return null; end if;
  select * into matched from blocked_customers where company_id = p_company_id and key = any(p_keys)
    order by created_at desc, key limit 1;
  if not found then return null; end if;
  update blocked_customers set blocked_count = blocked_count + 1, last_blocked_at = now()
    where company_id = p_company_id and key = matched.key and block_id = matched.block_id;
  if not found then return null; end if;
  insert into blocked_customers(company_id, key, block_id, label, conversation_id, blocked_by, created_at)
    select p_company_id, key, matched.block_id, matched.label, matched.conversation_id, matched.blocked_by, matched.created_at
    from (select distinct unnest(p_keys) as key) keys where key ~ '^(pn|lid):[0-9]{5,20}$'
    on conflict (company_id, key) do nothing;
  return matched.block_id;
end $$;

create or replace function public.list_blocked_customers(p_company_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(b)) order by b."createdAt" desc, b."blockId"), '[]'::jsonb) from (
    select block_id as "blockId", max(label) as label, array_agg(key order by key) as keys,
      max(conversation_id) as "conversationId", max(blocked_by) as "blockedBy",
      to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      sum(blocked_count)::integer as "blockedCount",
      to_char(max(last_blocked_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastBlockedAt"
    from blocked_customers where company_id = p_company_id group by block_id
  ) b;
$$;

-- Latest bodies from 202609180001_email_alerts.sql, plus reached AI limits. The 80% budget item
-- is hidden while the monthly limit itself is reached, and a blocked number never needs staff.
create or replace function public.has_overdue_attention(p_company_id text,p_minutes integer) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from orders where company_id=p_company_id and data->>'status'='pending' and data->>'sandbox'='false' and created_at<now()-make_interval(mins=>p_minutes))
    or exists(select 1 from conversations where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human' and data->'messages'->-1->>'role' is distinct from 'staff' and jsonb_typeof(data->'blocked') is distinct from 'object' and updated_at<now()-make_interval(mins=>p_minutes))
    or exists(select 1 from jobs where company_id=p_company_id and status='failed' and data->>'kind'<>'staff_alert' and created_at<now()-make_interval(mins=>p_minutes))
    or company_budget_warning(p_company_id)
    or exists(select 1 from ai_limit_hits where company_id=p_company_id and last_hit_at>now()-interval '1 hour');
$$;
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
    select 'handoff:'||id,'handoff',id,updated_at,null,null from conversations
      where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human' and data->'messages'->-1->>'role' is distinct from 'staff'
        and jsonb_typeof(data->'blocked') is distinct from 'object'
    union all
    select 'job:'||id,'job',id,created_at,null,null from jobs
      where company_id=p_company_id and status='failed'
    union all
    select 'budget:'||p_company_id||':'||to_char(now() at time zone 'UTC','YYYY-MM'),'budget',p_company_id,date_trunc('month',now()),null,null
      where company_budget_warning(p_company_id) and not exists(select 1 from limits where scope='monthly')
    union all
    select 'limit:'||scope||':'||window_key,'limit',p_company_id,first_hit_at,scope,resets_at from limits
  )
  select jsonb_build_object('total',(select count(*) from alerts),
    'orders',(select count(*) from alerts where kind='order'),
    'handoffs',(select count(*) from alerts where kind='handoff'),
    'failures',(select count(*) from alerts where kind='job'),
    'budgets',(select count(*) from alerts where kind='budget'),
    'limits',(select count(*) from alerts where kind='limit'),
    'items',coalesce((select jsonb_agg(jsonb_strip_nulls(to_jsonb(a))) from (select * from alerts order by "createdAt" desc,id limit 30) a),'[]'::jsonb));
$$;

-- Latest body from 202610160001_delivery_followups.sql (it must already be applied). Changed only
-- in the conversation update: like the worker, it also clears an AI limit pause, so a retried
-- stream cannot hand the chat back to the bot, and it leaves a blocked number's chat alone.
create or replace function public.fail_exhausted_orderly_jobs(p_limit integer default 20) returns integer
language plpgsql security definer set search_path = '' as $$
declare target record; failed_conversation_id text; trace_id text; affected integer := 0;
  failed_at timestamptz := now();
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
    if target.data->>'kind' = 'incoming' then
      if target.data->'payload' ? 'whatsappAddress' then
        select c.id into failed_conversation_id from public.conversations c
          where c.company_id = target.company_id and c.channel = 'whatsapp'
            and c.data->'whatsappAddress' = target.data->'payload'->'whatsappAddress'
          for update of c;
      else
        select c.id into failed_conversation_id from public.conversations c
          where c.company_id = target.company_id and c.channel = 'whatsapp'
            and c.customer_phone = target.data->'payload'->>'phone'
          for update of c;
      end if;
      -- Preserve every other field and advance both representations of version.
      update public.conversations c set version = c.version + 1, updated_at = failed_at,
        data = (c.data - 'botPausedAt' - 'limitPause') || jsonb_build_object('mode', 'human', 'version', c.version + 1,
          'updatedAt', to_char(failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        where c.id = failed_conversation_id and c.company_id = target.company_id
          and (c.data->>'mode' = 'bot' or c.data ? 'botPausedAt' or c.data ? 'limitPause')
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
    update public.jobs set status = 'failed', lease_until = null,
      data = (data - 'leaseUntil') || jsonb_build_object('status', 'failed', 'error', failure_message)
      where id = target.id;
    trace_id := gen_random_uuid()::text;
    insert into public.traces(id, company_id, conversation_id, created_at, data)
      values (trace_id, target.company_id, failed_conversation_id, failed_at,
        jsonb_strip_nulls(jsonb_build_object('id', trace_id, 'companyId', target.company_id,
          'conversationId', failed_conversation_id, 'action', 'job.failed',
          'detail', 'Job ' || target.id || ' stopped after the retry limit. Review saved work before retrying.',
          'createdAt', to_char(failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname=any(array['ai_limit_value','ai_limit_settings','record_ai_limit_hit','reserve_ai_call','ai_limit_status',
      'ai_replies_this_hour','block_customer','unblock_customer','blocked_customer_hit','list_blocked_customers',
      'has_overdue_attention','staff_attention','fail_exhausted_orderly_jobs']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
