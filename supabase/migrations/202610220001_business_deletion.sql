-- Deleting a whole business from the People page (Delete business), as the incident runbook's
-- workspace deletion did by hand: delete_company removes the business and everything of it in one
-- transaction (traces and orders first, as they point at chats without a cascade; deleting the
-- companies row then removes the rest), refuses while its bot is on or work is running, and
-- records who did it in the audit table, which keeps no message text. The business's id and its
-- WhatsApp connections' ids are kept as deleted: a save that raced the deletion (the settings
-- save is insert-or-update) cannot bring a bare business back, and the gateway is told to end a
-- linked-phone session it may still run for that connection (410), not ignored (200).
-- check_company_deletable makes the same refusals without changing anything, so the backend can
-- ask before it logs a linked phone out. An index on traces by chat keeps the deletion (and the
-- erasure and retention purges) from reading all of a business's traces once per chat.
-- Apply after 202610210001_deals.sql and before deploying the backend that calls delete_company.
-- The backend and dashboard running now keep working: no existing function changes, and the only
-- new rule on an existing table refuses to insert a business id that was deleted here.
-- Safe to rerun.
set lock_timeout = '5s';
do $$
begin
  if to_regclass('public.orderly_schema_migrations') is null then
    raise exception 'Apply 202610210001_deals.sql before 202610220001_business_deletion.sql';
  end if;
  if not exists(select 1 from public.orderly_schema_migrations where name = '202610210001_deals.sql') then
    raise exception 'Apply 202610210001_deals.sql before 202610220001_business_deletion.sql';
  end if;
end $$;

-- What was deleted, never what it held. No link to the business: these rows outlive it. Only the
-- backend reads them, and nothing changes or removes them.
create table if not exists public.deleted_companies (
  id text primary key,
  deleted_at timestamptz not null default now(),
  deleted_by text
);
create table if not exists public.deleted_whatsapp_connections (
  id text primary key,
  deleted_at timestamptz not null default now()
);
alter table public.deleted_companies enable row level security;
alter table public.deleted_whatsapp_connections enable row level security;
revoke all on public.deleted_companies, public.deleted_whatsapp_connections
  from public, anon, authenticated, service_role;
grant select, insert on public.deleted_companies, public.deleted_whatsapp_connections to service_role;

-- A deleted business stays deleted: a settings save or a pairing that was still running when it
-- went would otherwise insert a bare companies row again (save_company_settings inserts when the
-- row is missing). The backend answers this with 404 "This business was deleted."
-- AFTER, not BEFORE: an insert-or-update that meets a delete still running waits for it, and only
-- then inserts, after any BEFORE trigger has already passed. An AFTER trigger runs only for a row
-- really inserted, after that wait, and its check then sees the committed deletion, so the save
-- is refused and its row discarded. An ordinary save of a business that exists is an update and
-- never runs it.
create or replace function public.refuse_deleted_company() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists(select 1 from deleted_companies where id = new.id) then
    raise exception 'This business was deleted and cannot be saved again';
  end if;
  return null;
end $$;
drop trigger if exists refuse_deleted_company on public.companies;
create trigger refuse_deleted_company after insert on public.companies
  for each row execute function public.refuse_deleted_company();

-- Each chat deleted with a business checks traces for rows still naming it (traces point at
-- chats without a cascade). Without this index each check reads all of the business's traces.
-- Building it pauses trace writes for a moment (the lock_timeout above bounds the wait for it).
create index if not exists traces_conversation on public.traces(company_id, conversation_id);

-- Whether delete_company would refuse this business, changing nothing: unknown by this id and
-- slug, its bot on, a job of it running or a chat of it locked (as erase_customer). The backend
-- asks first, before it logs a linked phone out; delete_company makes the same checks again.
create or replace function public.check_company_deletable(p_company_id text, p_slug text) returns void
language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
begin
  if not exists(select 1 from companies where id = p_company_id and slug = p_slug) then
    raise exception 'Unknown company';
  end if;
  if exists(select 1 from companies where id = p_company_id and data->>'botEnabled' = 'true') then
    raise exception 'Pause automation before deleting this business';
  end if;
  if exists(select 1 from jobs where company_id = p_company_id and status = 'processing' and lease_until > now())
    or exists(select 1 from conversation_locks where company_id = p_company_id and lease_until > now()) then
    raise exception 'Wait for running work before deleting this business';
  end if;
end $$;

-- Deletes one business for good, named by its id and its slug, so a typo cannot reach another.
-- Refused, deleting nothing, for the reasons check_company_deletable gives. Answers how much
-- went, for the admin's message.
create or replace function public.delete_company(p_company_id text, p_slug text, p_actor_id text) returns jsonb
language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
declare removed jsonb; n integer;
begin
  perform 1 from companies where id = p_company_id and slug = p_slug for update;
  if not found then raise exception 'Unknown company'; end if;
  perform check_company_deletable(p_company_id, p_slug);
  removed := jsonb_build_object(
    'orders', (select count(*) from orders where company_id = p_company_id),
    'conversations', (select count(*) from conversations where company_id = p_company_id),
    'products', (select count(*) from products where company_id = p_company_id),
    'deals', (select count(*) from deals where company_id = p_company_id));
  insert into deleted_companies(id, deleted_by) values (p_company_id, p_actor_id)
    on conflict (id) do nothing;
  insert into deleted_whatsapp_connections(id)
    select id from whatsapp_connections where company_id = p_company_id
    on conflict (id) do nothing;
  delete from traces where company_id = p_company_id;
  delete from orders where company_id = p_company_id;
  delete from companies where id = p_company_id and slug = p_slug;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Unknown company'; end if;
  perform audit_event(p_company_id, p_actor_id, 'admin.workspace_deleted');
  return removed;
end $$;

revoke all on function public.check_company_deletable(text, text) from public, anon, authenticated;
grant execute on function public.check_company_deletable(text, text) to service_role;
revoke all on function public.delete_company(text, text, text) from public, anon, authenticated;
grant execute on function public.delete_company(text, text, text) to service_role;
-- The trigger's function, never called on its own.
revoke all on function public.refuse_deleted_company() from public, anon, authenticated, service_role;

insert into public.orderly_schema_migrations(name) values ('202610220001_business_deletion.sql')
  on conflict (name) do nothing;
notify pgrst, 'reload schema';
