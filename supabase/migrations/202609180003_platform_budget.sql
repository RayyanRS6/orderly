create table public.platform_limits(id boolean primary key default true check(id),monthly_budget_usd numeric not null default 100 check(monthly_budget_usd between 0 and 100000));
insert into public.platform_limits(id) values(true);
alter table public.platform_limits enable row level security;
revoke all on public.platform_limits from public,anon,authenticated;
grant all on public.platform_limits to service_role;
alter table public.budget_reservations add column funding text not null default 'platform' check(funding in ('platform','own'));

create function public.platform_budget() returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('limitUsd',monthly_budget_usd,
    'spentUsd',(select coalesce(sum(cost_usd),0) from usage_events where coalesce(data->>'funding','platform')='platform' and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'),
    'reservedUsd',(select coalesce(sum(amount_usd),0) from budget_reservations where funding='platform' and settled_at is null and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'))
  from platform_limits where id;
$$;
create function public.configure_platform_budget(p_limit numeric) returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_limit is null or p_limit not between 0 and 100000 then raise exception 'Invalid platform budget'; end if;
  update platform_limits set monthly_budget_usd=p_limit where id;
  return platform_budget();
end $$;

create or replace function public.reserve_budget(p_company_id text,p_reservation_id text,p_amount_usd numeric,p_expires_at timestamptz) returns boolean language plpgsql security definer set search_path=public as $$
declare budget numeric; spent numeric; reserved numeric; payer text; platform jsonb; month_start timestamptz:=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_amount_usd<0 or p_amount_usd is null or p_amount_usd in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) or p_expires_at<=now() or p_expires_at is null then raise exception 'Invalid budget reservation'; end if;
  select (data->'ai'->>'monthlyBudgetUsd')::numeric,coalesce(data->'ai'->>'keyMode','platform') into budget,payer from companies where id=p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  if budget is null or budget<0 then raise exception 'Invalid company budget'; end if;
  if exists(select 1 from budget_reservations where id=p_reservation_id) or exists(select 1 from usage_events where id=p_reservation_id) then return false; end if;
  select coalesce(sum(cost_usd),0) into spent from usage_events where company_id=p_company_id and created_at>=month_start and created_at<month_start+interval '1 month';
  select coalesce(sum(amount_usd),0) into reserved from budget_reservations where company_id=p_company_id and settled_at is null and created_at>=month_start and created_at<month_start+interval '1 month';
  if spent+reserved+p_amount_usd>budget then return false; end if;
  if payer='platform' then
    -- Serialize reservations across businesses using Orderly-funded keys.
    perform 1 from platform_limits where id for update;
    platform:=platform_budget();
    if (platform->>'spentUsd')::numeric+(platform->>'reservedUsd')::numeric+p_amount_usd>(platform->>'limitUsd')::numeric then return false; end if;
  end if;
  insert into budget_reservations(id,company_id,amount_usd,expires_at,funding) values(p_reservation_id,p_company_id,p_amount_usd,p_expires_at,payer);
  return true;
end $$;
create or replace function public.settle_budget(p_reservation_id text,p_usage jsonb) returns void language plpgsql security definer set search_path=public as $$
declare reservation budget_reservations%rowtype;
begin
  perform 1 from companies where id=p_usage->>'companyId' for update;
  select * into reservation from budget_reservations where id=p_reservation_id for update;
  if not found or reservation.company_id is distinct from p_usage->>'companyId' or p_usage->>'id' is distinct from p_reservation_id then raise exception 'Invalid budget settlement'; end if;
  if reservation.settled_at is not null then return; end if;
  perform record_usage(p_usage||jsonb_build_object('funding',reservation.funding));
  update budget_reservations set settled_at=now() where id=p_reservation_id;
end $$;
revoke all on function public.platform_budget(),public.configure_platform_budget(numeric) from public,anon,authenticated;
grant execute on function public.platform_budget(),public.configure_platform_budget(numeric) to service_role;
