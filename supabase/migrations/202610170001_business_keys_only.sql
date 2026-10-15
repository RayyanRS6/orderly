-- Every business answers with its own provider API key; Orderly no longer funds a shared
-- one. Apply after 202610160001 and before deploying the code that stops reading keyMode.
-- Safe to rerun.

-- Only on the first run (the shared-budget table still exists): once the new code runs it
-- drops the label, and an unlabelled business must not be taken for an Orderly-funded one.
do $$
begin
  if to_regclass('public.platform_limits') is null then return; end if;
  -- A business still set to an Orderly-funded real provider (no label meant that too) has
  -- no key of its own on file for that choice: pause it and make it connect and verify
  -- its own key. Demo-provider businesses never call a provider, so only the label changes.
  update public.companies
  set data = (data - 'modelVerification') || '{"botEnabled":false}'::jsonb
  where coalesce(data->'ai'->>'keyMode', 'platform') = 'platform'
    and coalesce(data->'ai'->>'provider', 'mock') <> 'mock';
  -- Mark every business as paying with its own key. The label stays for now so the code
  -- still running until the new code is deployed reads it as before.
  update public.companies
  set data = jsonb_set(data, '{ai,keyMode}', '"own"')
  where data ? 'ai' and data->'ai'->>'keyMode' is distinct from 'own';
end $$;

-- The budget functions from 202609090001_initial.sql: only the business's own monthly
-- cap applies.
create or replace function public.reserve_budget(p_company_id text, p_reservation_id text, p_amount_usd numeric, p_expires_at timestamptz) returns boolean language plpgsql security definer set search_path = public as $$
declare budget numeric; spent numeric; reserved numeric; month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_amount_usd < 0 or p_amount_usd is null or p_amount_usd in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) or p_expires_at <= now() or p_expires_at is null then raise exception 'Invalid budget reservation'; end if;
  select (data->'ai'->>'monthlyBudgetUsd')::numeric into budget from companies where id = p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  if budget is null or budget < 0 then raise exception 'Invalid company budget'; end if;
  if exists(select 1 from budget_reservations where id = p_reservation_id) or exists(select 1 from usage_events where id = p_reservation_id) then return false; end if;
  select coalesce(sum(cost_usd),0) into spent from usage_events where company_id = p_company_id and created_at >= month_start and created_at < month_start + interval '1 month';
  -- A killed function may still have incurred upstream charges. Never silently release its hold.
  select coalesce(sum(amount_usd),0) into reserved from budget_reservations where company_id = p_company_id and settled_at is null and created_at >= month_start and created_at < month_start + interval '1 month';
  if spent + reserved + p_amount_usd > budget then return false; end if;
  insert into budget_reservations(id,company_id,amount_usd,expires_at) values(p_reservation_id,p_company_id,p_amount_usd,p_expires_at);
  return true;
end $$;
create or replace function public.settle_budget(p_reservation_id text, p_usage jsonb) returns void language plpgsql security definer set search_path = public as $$
declare reservation budget_reservations%rowtype;
begin
  perform 1 from companies where id = p_usage->>'companyId' for update;
  select * into reservation from budget_reservations where id = p_reservation_id for update;
  if not found or reservation.company_id is distinct from p_usage->>'companyId' or p_usage->>'id' is distinct from p_reservation_id then raise exception 'Invalid budget settlement'; end if;
  if reservation.settled_at is not null then return; end if;
  perform record_usage(p_usage);
  update budget_reservations set settled_at = now() where id = p_reservation_id;
end $$;

-- The shared Orderly budget (202609180003_platform_budget.sql). settle_budget above no
-- longer reads the funding column, so it can go. Past usage keeps its "funding" label.
drop function if exists public.configure_platform_budget(numeric);
drop function if exists public.platform_budget();
drop table if exists public.platform_limits;
alter table public.budget_reservations drop column if exists funding;
