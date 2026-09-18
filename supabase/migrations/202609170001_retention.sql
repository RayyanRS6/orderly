-- Retention is deliberately opt-in. Existing workspaces get no enabled policy.
create table public.retention_policies (
  company_id text primary key references public.companies(id) on delete cascade,
  days integer not null default 0 check (days=0 or days between 30 and 3650),
  eligible_after timestamptz,
  last_attempt_at timestamptz,
  last_run_at timestamptz,
  last_deleted integer not null default 0
);
alter table public.retention_policies enable row level security;
revoke all on public.retention_policies from public,anon,authenticated;
grant all on public.retention_policies to service_role;
create index orders_retention_conversation on public.orders(company_id,conversation_id,updated_at);
create index jobs_unfinished_conversation on public.jobs(company_id,(data->'payload'->>'conversationId')) where status<>'done';
create index jobs_unfinished_order on public.jobs(company_id,(data->'payload'->>'orderId')) where status<>'done';
create index jobs_unfinished_phone on public.jobs(company_id,(data->'payload'->>'phone')) where status<>'done';

create function public.retention_candidates(p_company_id text,p_days integer)
returns setof text language sql stable security definer set search_path=public as $$
  select c.id from conversations c
  where p_days between 30 and 3650 and c.company_id=p_company_id
    and c.updated_at < now()-make_interval(days=>p_days)
    and coalesce((c.data->>'lastInboundAt')::timestamptz,c.updated_at) < now()-make_interval(days=>p_days)
    and c.data->>'mode'='bot'
    and not exists(select 1 from orders o where o.company_id=c.company_id and o.conversation_id=c.id
      and (coalesce(o.data->>'status','') not in ('completed','rejected','cancelled') or
        greatest(o.created_at,o.updated_at) >= now()-make_interval(days=>p_days)))
    and not exists(select 1 from conversation_locks l where l.company_id=c.company_id and l.conversation_id=c.id and l.lease_until>now())
    and not exists(select 1 from jobs j where j.company_id=c.company_id and j.status<>'done' and
      (j.data->'payload'->>'conversationId'=c.id or j.data->'payload'->>'phone'=c.customer_phone or
       j.data->'payload'->>'orderId' in (select o.id from orders o where o.company_id=c.company_id and o.conversation_id=c.id)))
  order by c.updated_at,c.id limit 100;
$$;

create function public.retention_status(p_company_id text,p_preview_days integer default 0)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('days',coalesce(p.days,0),'eligibleAfter',p.eligible_after,
    'lastRunAt',p.last_run_at,'lastDeleted',coalesce(p.last_deleted,0),
    'eligibleConversations',(select count(*) from retention_candidates(p_company_id,p_preview_days)))
  from (select 1) s left join retention_policies p on p.company_id=p_company_id;
$$;

create function public.configure_retention(p_company_id text,p_days integer,p_actor_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_days is null or not (p_days=0 or p_days between 30 and 3650) then raise exception 'Invalid retention period'; end if;
  perform 1 from companies where id=p_company_id for update;
  insert into retention_policies(company_id,days,eligible_after)
    values(p_company_id,p_days,case when p_days>0 then now()+interval '24 hours' end)
    on conflict(company_id) do update set days=excluded.days,
      eligible_after=case when retention_policies.days=excluded.days then retention_policies.eligible_after else excluded.eligible_after end;
  perform audit_event(p_company_id,p_actor_id,'privacy.retention_days.'||p_days);
  return retention_status(p_company_id,p_days);
end $$;

-- Serialize new processing leases with deletion. Existing leases are excluded below.
create or replace function public.acquire_conversation_lock(p_company_id text,p_conversation_id text,p_owner_id text,p_lease_until timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
declare claimed integer;
begin
  if p_lease_until <= now() or p_lease_until is null or p_owner_id is null or p_owner_id = '' then raise exception 'Invalid conversation lease'; end if;
  perform 1 from companies where id=p_company_id for update;
  insert into conversation_locks(company_id,conversation_id,owner_id,lease_until) values(p_company_id,p_conversation_id,p_owner_id,p_lease_until)
    on conflict(company_id,conversation_id) do update set owner_id=excluded.owner_id,lease_until=excluded.lease_until
    where conversation_locks.lease_until <= now() or conversation_locks.owner_id = p_owner_id;
  get diagnostics claimed = row_count; return claimed = 1;
end $$;

create function public.run_retention(p_company_id text) returns integer
language plpgsql security definer set search_path=public as $$
declare policy retention_policies; ids text[]; order_ids text[]; phones text[]; n integer;
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
  select array_agg(customer_phone) into phones from conversations where company_id=p_company_id and id=any(ids);
  -- Keep webhook/job dedupe tombstones, remove their personal data and provider errors.
  update jobs set lease_until=null,data=(data-'leaseUntil'-'lastError'-'error')||'{"payload":{}}'::jsonb
    where company_id=p_company_id and status='done' and
      (data->'payload'->>'conversationId'=any(ids) or data->'payload'->>'phone'=any(phones) or data->'payload'->>'orderId'=any(order_ids));
  delete from traces where company_id=p_company_id and conversation_id=any(ids);
  update usage_events set data=data-'conversationId' where company_id=p_company_id and data->>'conversationId'=any(ids);
  delete from orders where company_id=p_company_id and conversation_id=any(ids);
  delete from conversation_locks where company_id=p_company_id and conversation_id=any(ids);
  delete from conversations where company_id=p_company_id and id=any(ids);
  n:=coalesce(cardinality(ids),0);
  update retention_policies set last_run_at=now(),last_deleted=n where company_id=p_company_id;
  if n>0 then perform audit_event(p_company_id,'system','privacy.retention_deleted.'||n); end if;
  return n;
end $$;

create function public.run_retention_batch() returns integer
language plpgsql security definer set search_path=public as $$
declare row record; total integer:=0;
begin
  for row in select company_id from retention_policies where days>0 and eligible_after<=now()
    order by last_attempt_at nulls first,company_id limit 20 loop
    begin
      total:=total+run_retention(row.company_id);
    exception when others then
      update retention_policies set last_attempt_at=now() where company_id=row.company_id;
      perform audit_event(row.company_id,'system','privacy.retention_failed');
    end;
  end loop;
  return total;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname=any(array['retention_candidates','retention_status','configure_retention','run_retention','run_retention_batch']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- Manual erasure must also remove provider error text from job tombstones.
create or replace function public.erase_customer(p_company_id text,p_phone text) returns integer language plpgsql security definer set search_path=public as $$
declare ids text[]; order_ids text[];
begin
  perform 1 from companies where id=p_company_id for update;
  if exists(select 1 from companies where id=p_company_id and data->>'botEnabled'='true') or exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) or exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now()) then raise exception 'Pause automation and wait for running work before deleting customer data'; end if;
  select array_agg(id) into ids from conversations where company_id=p_company_id and customer_phone=p_phone;
  select array_agg(id) into order_ids from orders where company_id=p_company_id and conversation_id=any(ids);
  -- Keep dedupe tombstones, remove payloads so webhook retries cannot restore deleted data.
  update jobs set status='done',lease_until=null,data=(data-'leaseUntil'-'lastError'-'error')||'{"status":"done","payload":{}}'::jsonb where company_id=p_company_id and (data->'payload'->>'phone'=p_phone or data->'payload'->>'conversationId'=any(ids) or data->'payload'->>'orderId'=any(order_ids));
  delete from traces where company_id=p_company_id and conversation_id=any(ids);
  update usage_events set data=data-'conversationId' where company_id=p_company_id and data->>'conversationId'=any(ids);
  delete from orders where company_id=p_company_id and conversation_id=any(ids);
  delete from conversations where company_id=p_company_id and id=any(ids);
  return coalesce(cardinality(ids),0);
end $$;
