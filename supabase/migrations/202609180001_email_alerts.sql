create table public.alert_subscriptions (
  company_id text not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  response_minutes integer not null default 10 check(response_minutes between 5 and 120),
  last_checked_at timestamptz,
  last_queued_at timestamptz,
  primary key(company_id,user_id)
);
alter table public.alert_subscriptions enable row level security;
revoke all on public.alert_subscriptions from public,anon,authenticated;
grant all on public.alert_subscriptions to service_role;

create function public.alert_preferences(p_company_id text,p_user_id uuid) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('enabled',coalesce(s.enabled,false),'responseMinutes',coalesce(s.response_minutes,10),
    'emailVerified',exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null and nullif(email,'') is not null))
  from (select 1) x left join alert_subscriptions s on s.company_id=p_company_id and s.user_id=p_user_id;
$$;
create function public.configure_alerts(p_company_id text,p_user_id uuid,p_enabled boolean,p_minutes integer) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from company_memberships where company_id=p_company_id and user_id=p_user_id)
    and not exists(select 1 from platform_admins where user_id=p_user_id) then raise exception 'Membership required'; end if;
  if p_enabled and not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null and nullif(email,'') is not null) then raise exception 'Verified account email required'; end if;
  insert into alert_subscriptions(company_id,user_id,enabled,response_minutes) values(p_company_id,p_user_id,p_enabled,p_minutes)
    on conflict(company_id,user_id) do update set enabled=excluded.enabled,response_minutes=excluded.response_minutes;
  perform audit_event(p_company_id,p_user_id::text,'notifications.email.'||p_enabled::text);
  return alert_preferences(p_company_id,p_user_id);
end $$;
create function public.alert_recipient(p_company_id text,p_user_id uuid) returns text
language sql stable security definer set search_path=public as $$
  select u.email from auth.users u join alert_subscriptions s on s.user_id=u.id
  where s.company_id=p_company_id and s.enabled and u.email_confirmed_at is not null
    and (exists(select 1 from company_memberships m where m.company_id=p_company_id and m.user_id=u.id)
      or exists(select 1 from platform_admins a where a.user_id=u.id));
$$;

create function public.company_budget_warning(p_company_id text) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from companies c where c.id=p_company_id and (c.data->'ai'->>'monthlyBudgetUsd')::numeric>0
    and ((select coalesce(sum(cost_usd),0) from usage_events where company_id=p_company_id and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')+
      (select coalesce(sum(amount_usd),0) from budget_reservations where company_id=p_company_id and settled_at is null and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')) >= (c.data->'ai'->>'monthlyBudgetUsd')::numeric*0.8);
$$;
create function public.has_overdue_attention(p_company_id text,p_minutes integer) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from orders where company_id=p_company_id and data->>'status'='pending' and data->>'sandbox'='false' and created_at<now()-make_interval(mins=>p_minutes))
    or exists(select 1 from conversations where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human' and data->'messages'->-1->>'role' is distinct from 'staff' and updated_at<now()-make_interval(mins=>p_minutes))
    or exists(select 1 from jobs where company_id=p_company_id and status='failed' and data->>'kind'<>'staff_alert' and created_at<now()-make_interval(mins=>p_minutes))
    or company_budget_warning(p_company_id);
$$;

create function public.queue_staff_alerts() returns integer
language plpgsql security definer set search_path=public as $$
declare subscription alert_subscriptions; job_id text; inserted boolean; total integer:=0;
begin
  for subscription in select * from alert_subscriptions where enabled order by last_checked_at nulls first,company_id,user_id limit 100 for update skip locked loop
    update alert_subscriptions set last_checked_at=now() where company_id=subscription.company_id and user_id=subscription.user_id;
    if subscription.last_queued_at>now()-interval '1 hour' then continue; end if;
    if alert_recipient(subscription.company_id,subscription.user_id) is null or not has_overdue_attention(subscription.company_id,subscription.response_minutes) then continue; end if;
    job_id:=gen_random_uuid()::text;
    inserted:=insert_job(jsonb_build_object('id',job_id,'companyId',subscription.company_id,'kind','staff_alert','payload',jsonb_build_object('userId',subscription.user_id),'status','pending','attempts',0,'nextRunAt',now(),'createdAt',now()),
      'staff-alert:'||subscription.company_id||':'||subscription.user_id||':'||floor(extract(epoch from now())/3600)::text);
    update alert_subscriptions set last_queued_at=now() where company_id=subscription.company_id and user_id=subscription.user_id;
    if inserted then total:=total+1; end if;
  end loop;
  return total;
end $$;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname=any(array['company_budget_warning','alert_preferences','configure_alerts','alert_recipient','has_overdue_attention','queue_staff_alerts']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

create or replace function public.disconnect_integration(p_company_id text,p_kind text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from companies where id=p_company_id for update;
  if exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) or exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now()) then raise exception 'Wait for running work before disconnecting'; end if;
  delete from integrations where company_id=p_company_id and kind=p_kind;
  update jobs set status='done',lease_until=null,data=(data-'leaseUntil')||'{"status":"done","payload":{}}'::jsonb where company_id=p_company_id and ((p_kind='sheets' and data->>'kind'='sheet_sync') or (p_kind='whatsapp' and data->>'kind' in ('incoming','whatsapp_send')));
  update companies set data=(data-'modelVerification')||'{"botEnabled":false}'::jsonb where id=p_company_id;
end $$;

create or replace function public.staff_attention(p_company_id text) returns jsonb
language sql stable security definer set search_path=public as $$
  with alerts as (
    select 'order:'||id as id,'order'::text as kind,id as "entityId",created_at as "createdAt"
      from orders where company_id=p_company_id and data->>'status'='pending' and data->>'sandbox'='false'
    union all
    select 'handoff:'||id,'handoff',id,updated_at from conversations
      where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human' and data->'messages'->-1->>'role' is distinct from 'staff'
    union all
    select 'job:'||id,'job',id,created_at from jobs
      where company_id=p_company_id and status='failed'
    union all
    select 'budget:'||p_company_id||':'||to_char(now() at time zone 'UTC','YYYY-MM'),'budget',p_company_id,date_trunc('month',now()) where company_budget_warning(p_company_id)
  )
  select jsonb_build_object('total',(select count(*) from alerts),
    'orders',(select count(*) from alerts where kind='order'),
    'handoffs',(select count(*) from alerts where kind='handoff'),
    'failures',(select count(*) from alerts where kind='job'),
    'budgets',(select count(*) from alerts where kind='budget'),
    'items',coalesce((select jsonb_agg(to_jsonb(a)) from (select * from alerts order by "createdAt" desc,id limit 30) a),'[]'::jsonb));
$$;
revoke all on function public.staff_attention(text) from public,anon,authenticated;
grant execute on function public.staff_attention(text) to service_role;
