-- Run once against a Supabase project. Backend service role owns mutations;
-- authenticated browser sessions receive tenant-scoped SELECT privileges only.
create table public.companies (
  id text primary key, slug text not null unique, data jsonb not null,
  created_at timestamptz not null default now(),
  check (data->>'id' is not distinct from id),
  check (data->>'slug' is not distinct from slug)
);
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.company_memberships (
  company_id text not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  primary key (company_id, user_id)
);
create index memberships_user on public.company_memberships(user_id, company_id);
create table public.products (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  data jsonb not null, unique (company_id, id),
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id)
);
create table public.conversations (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  customer_phone text not null, channel text not null check (channel in ('demo', 'whatsapp')),
  version integer not null check (version >= 0), updated_at timestamptz not null, data jsonb not null,
  unique (company_id, id), unique (company_id, customer_phone, channel),
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id),
  check ((data->>'version')::integer is not distinct from version),
  check (data->>'customerPhone' is not distinct from customer_phone), check (data->>'channel' is not distinct from channel)
);
create index conversations_recent on public.conversations(company_id, updated_at desc);
create table public.orders (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  conversation_id text not null, submission_key text not null, data jsonb not null,
  created_at timestamptz not null, updated_at timestamptz not null,
  unique (company_id, id), unique (company_id, submission_key),
  foreign key (company_id, conversation_id) references public.conversations(company_id, id),
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id),
  check (data->>'conversationId' is not distinct from conversation_id), check (data->>'submissionKey' is not distinct from submission_key)
);
create index orders_recent on public.orders(company_id, created_at desc);
create table public.integrations (
  company_id text not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('whatsapp','sheets','openai','anthropic','gemini')),
  data jsonb not null, phone_number_id text unique,
  primary key (company_id, kind), check (data->>'kind' is not distinct from kind),
  check (phone_number_id is not distinct from case when kind = 'whatsapp' then nullif(data->'config'->>'phoneNumberId', '') else null end)
);
-- One writer per order destination. Blank tab names use the adapter's Orders default;
-- Sheets tab names are case-insensitive, while spreadsheet IDs remain case-sensitive.
create unique index integrations_sheet_destination_unique on public.integrations (
  (data->'config'->>'spreadsheetId'),
  (lower(coalesce(nullif(data->'config'->>'ordersSheet',''),'Orders')))
) where kind='sheets' and data->>'configured'='true' and nullif(data->'config'->>'spreadsheetId','') is not null;
-- Separate table ensures even SELECT permissions on integrations cannot expose ciphertext.
create table public.integration_secrets (
  company_id text not null, kind text not null, encrypted_secret text not null,
  primary key (company_id, kind),
  foreign key (company_id, kind) references public.integrations(company_id, kind) on delete cascade
);
create table public.traces (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  conversation_id text, data jsonb not null, created_at timestamptz not null,
  foreign key (company_id, conversation_id) references public.conversations(company_id, id),
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id),
  check (data->>'conversationId' is not distinct from conversation_id)
);
create index traces_recent on public.traces(company_id, created_at desc);
create table public.usage_events (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  cost_usd numeric not null check (cost_usd >= 0 and cost_usd != 'NaN'::numeric),
  data jsonb not null, created_at timestamptz not null,
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id),
  check ((data->>'costUsd')::numeric is not distinct from cost_usd)
);
create index usage_monthly on public.usage_events(company_id, created_at desc);
create table public.budget_reservations (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  amount_usd numeric not null check (amount_usd >= 0 and amount_usd != 'NaN'::numeric),
  expires_at timestamptz not null, settled_at timestamptz, created_at timestamptz not null default now()
);
create index reservations_active on public.budget_reservations(company_id, expires_at) where settled_at is null;
create table public.jobs (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  arrival_sequence bigint generated always as identity unique,
  dedupe_key text unique, status text not null check (status in ('pending','processing','done','failed')),
  attempts integer not null default 0 check (attempts >= 0), next_run_at timestamptz not null,
  lease_until timestamptz, created_at timestamptz not null, data jsonb not null,
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id),
  check (data->>'status' is not distinct from status), check ((data->>'attempts')::integer is not distinct from attempts)
);
create index jobs_due on public.jobs(next_run_at, lease_until) where status in ('pending','processing');
create index incoming_job_order on public.jobs(company_id, (data->'payload'->>'phone'), arrival_sequence)
  where data->>'kind'='incoming' and status!='done';
create table public.conversation_locks (
  company_id text not null, conversation_id text not null, owner_id text not null, lease_until timestamptz not null,
  primary key (company_id, conversation_id),
  foreign key (company_id) references public.companies(id) on delete cascade
);

-- A service-role upsert must not reassign an existing entity to another tenant.
create function public.enforce_company_ownership() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.company_id != old.company_id then raise exception 'Cross-company reassignment is forbidden'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['products','conversations','orders','traces','usage_events','jobs','budget_reservations'] loop
    execute format('create trigger immutable_company before update on public.%I for each row execute function public.enforce_company_ownership()', t);
  end loop;
end $$;

-- Product snapshots survive catalog deletion. Existing foreign-tenant ids are rejected.
create function public.enforce_json_references() returns trigger language plpgsql set search_path = public as $$
declare item jsonb; reference_id text;
begin
  if tg_table_name in ('conversations', 'orders') then
    for item in select value from jsonb_array_elements(case when tg_table_name = 'conversations' then coalesce(new.data->'cart'->'items', '[]'::jsonb) else coalesce(new.data->'items', '[]'::jsonb) end) loop
      if exists(select 1 from products where id = item->>'productId' and company_id != new.company_id) then raise exception 'Cross-company product reference'; end if;
    end loop;
  end if;
  if tg_table_name = 'conversations' then
    reference_id := new.data->'cart'->>'orderId';
    if exists(select 1 from orders where id = reference_id and company_id != new.company_id) then raise exception 'Cross-company cart order reference'; end if;
  end if;
  if tg_table_name = 'jobs' then
    reference_id := new.data->'payload'->>'conversationId';
    if reference_id is not null and not exists(select 1 from conversations where id = reference_id and company_id = new.company_id) then raise exception 'Invalid job conversation'; end if;
    reference_id := new.data->'payload'->>'orderId';
    if reference_id is not null and not exists(select 1 from orders where id = reference_id and company_id = new.company_id) then raise exception 'Invalid job order'; end if;
  end if;
  return new;
end $$;
create trigger check_conversation_references before insert or update on public.conversations for each row execute function public.enforce_json_references();
create trigger check_order_references before insert or update on public.orders for each row execute function public.enforce_json_references();
create trigger check_job_references before insert or update on public.jobs for each row execute function public.enforce_json_references();

create function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from platform_admins where user_id = auth.uid());
$$;
create function public.is_company_member(p_company_id text) returns boolean language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or exists(select 1 from company_memberships where company_id = p_company_id and user_id = auth.uid());
$$;
do $$ declare t text; begin
  foreach t in array array['companies','platform_admins','company_memberships','products','conversations','orders','integrations','integration_secrets','traces','usage_events','budget_reservations','jobs','conversation_locks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  foreach t in array array['products','conversations','orders','integrations','traces','usage_events'] loop
    execute format('create policy company_read on public.%I for select to authenticated using (public.is_company_member(company_id))', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
create policy companies_read on public.companies for select to authenticated using (public.is_company_member(id));
create policy membership_read on public.company_memberships for select to authenticated using (user_id = auth.uid() or public.is_platform_admin());
create policy admin_read on public.platform_admins for select to authenticated using (user_id = auth.uid());
grant select on public.companies, public.company_memberships, public.platform_admins to authenticated;
grant usage on schema public to authenticated, service_role;

create function public.save_conversation(p_conversation jsonb, p_expected_version integer default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare current_row conversations%rowtype; c_id text := p_conversation->>'id'; tenant text := p_conversation->>'companyId';
begin
  -- Company row serializes the initial find/create race as well as conflicting IDs.
  perform 1 from companies where id = tenant for update;
  if not found then raise exception 'Unknown company'; end if;
  select * into current_row from conversations where id = c_id for update;
  if found and current_row.company_id != tenant then raise exception 'Cross-company conversation'; end if;
  if exists(select 1 from conversations where company_id = tenant and customer_phone = p_conversation->>'customerPhone' and channel = p_conversation->>'channel' and id != c_id) then return false; end if;
  if p_expected_version is not null then
    if coalesce(current_row.version, 0) != p_expected_version then return false; end if;
    if (p_conversation->>'version')::integer != p_expected_version + 1 then raise exception 'Conversation version must advance by one'; end if;
  end if;
  insert into conversations(id,company_id,customer_phone,channel,version,updated_at,data)
    values(c_id,tenant,p_conversation->>'customerPhone',p_conversation->>'channel',(p_conversation->>'version')::integer,(p_conversation->>'updatedAt')::timestamptz,p_conversation)
    on conflict(id) do update set customer_phone=excluded.customer_phone,channel=excluded.channel,version=excluded.version,updated_at=excluded.updated_at,data=excluded.data;
  return true;
end $$;

create function public.record_usage(p_usage jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists(select 1 from usage_events where id = p_usage->>'id' and company_id != p_usage->>'companyId') then raise exception 'Cross-company usage'; end if;
  insert into usage_events(id, company_id, cost_usd, data, created_at)
    values(p_usage->>'id',p_usage->>'companyId',(p_usage->>'costUsd')::numeric,p_usage,(p_usage->>'createdAt')::timestamptz)
    on conflict(id) do nothing;
end $$;
create function public.insert_job(p_job jsonb, p_dedupe_key text default null) returns boolean language plpgsql security definer set search_path = public as $$
declare inserted integer;
begin
  -- Serialize arrival and claiming for one customer's stream. The identity is allocated
  -- only after this lock, so an earlier uncommitted insert cannot be overtaken.
  if p_job->>'kind'='incoming' then
    perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array('orderly-incoming',p_job->>'companyId',p_job->'payload'->>'phone')::text,0));
  end if;
  if exists(select 1 from jobs where id = p_job->>'id' and company_id != p_job->>'companyId') then raise exception 'Cross-company job'; end if;
  insert into jobs(id,company_id,dedupe_key,status,attempts,next_run_at,lease_until,created_at,data)
    values(p_job->>'id',p_job->>'companyId',p_dedupe_key,p_job->>'status',(p_job->>'attempts')::integer,(p_job->>'nextRunAt')::timestamptz,(p_job->>'leaseUntil')::timestamptz,(p_job->>'createdAt')::timestamptz,p_job)
    on conflict do nothing;
  get diagnostics inserted = row_count; return inserted = 1;
end $$;

create function public.commit_turn(p_company_id text, p_conversation jsonb, p_expected_version integer, p_order jsonb default null, p_jobs jsonb default '[]'::jsonb, p_usage jsonb default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare j jsonb; saved boolean;
begin
  if p_conversation->>'companyId' is distinct from p_company_id or (p_order is not null and p_order->>'companyId' is distinct from p_company_id) or (p_usage is not null and p_usage->>'companyId' is distinct from p_company_id) then raise exception 'Cross-company turn'; end if;
  perform 1 from companies where id = p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  if p_order is not null then
    if p_order->>'conversationId' is distinct from p_conversation->>'id' then raise exception 'Order must belong to turn conversation'; end if;
    if exists(select 1 from orders where id = p_order->>'id' and company_id != p_company_id) then raise exception 'Cross-company order'; end if;
    if exists(select 1 from orders where company_id = p_company_id and submission_key = p_order->>'submissionKey' and id != p_order->>'id') then return false; end if;
  end if;
  saved := save_conversation(p_conversation,p_expected_version);
  if not saved then return false; end if;
  if p_order is not null then
    insert into orders(id,company_id,conversation_id,submission_key,data,created_at,updated_at)
      values(p_order->>'id',p_company_id,p_order->>'conversationId',p_order->>'submissionKey',p_order,(p_order->>'createdAt')::timestamptz,(p_order->>'updatedAt')::timestamptz)
      on conflict(id) do update set data=excluded.data,updated_at=excluded.updated_at;
  end if;
  for j in select value from jsonb_array_elements(p_jobs) loop
    if j->>'companyId' is distinct from p_company_id then raise exception 'Cross-company job'; end if;
    perform insert_job(j);
  end loop;
  if p_usage is not null then perform record_usage(p_usage); end if;
  return true;
end $$;

create function public.replace_products(p_company_id text, p_products jsonb) returns void language plpgsql security definer set search_path = public as $$
declare p jsonb;
begin
  perform 1 from companies where id = p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  for p in select value from jsonb_array_elements(p_products) loop
    if p->>'companyId' is distinct from p_company_id then raise exception 'Cross-company catalog'; end if;
    if exists(select 1 from products where id = p->>'id' and company_id != p_company_id) then raise exception 'Cross-company product'; end if;
  end loop;
  delete from products where company_id = p_company_id;
  insert into products(id,company_id,data) select value->>'id',p_company_id,value from jsonb_array_elements(p_products);
end $$;
create function public.save_integration(p_company_id text, p_integration jsonb, p_encrypted_secret text default null) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into integrations(company_id,kind,data,phone_number_id)
    values(p_company_id,p_integration->>'kind',p_integration,case when p_integration->>'kind' = 'whatsapp' then nullif(p_integration->'config'->>'phoneNumberId','') else null end)
    on conflict(company_id,kind) do update set data=excluded.data,phone_number_id=excluded.phone_number_id;
  if p_encrypted_secret is not null then
    insert into integration_secrets(company_id,kind,encrypted_secret) values(p_company_id,p_integration->>'kind',p_encrypted_secret)
      on conflict(company_id,kind) do update set encrypted_secret=excluded.encrypted_secret;
  end if;
end $$;

create function public.reserve_budget(p_company_id text, p_reservation_id text, p_amount_usd numeric, p_expires_at timestamptz) returns boolean language plpgsql security definer set search_path = public as $$
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
create function public.settle_budget(p_reservation_id text, p_usage jsonb) returns void language plpgsql security definer set search_path = public as $$
declare reservation budget_reservations%rowtype;
begin
  perform 1 from companies where id = p_usage->>'companyId' for update;
  select * into reservation from budget_reservations where id = p_reservation_id for update;
  if not found or reservation.company_id is distinct from p_usage->>'companyId' or p_usage->>'id' is distinct from p_reservation_id then raise exception 'Invalid budget settlement'; end if;
  if reservation.settled_at is not null then return; end if;
  perform record_usage(p_usage);
  update budget_reservations set settled_at = now() where id = p_reservation_id;
end $$;

create function public.list_due_jobs(p_limit integer default 25) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(data),'[]'::jsonb) from (
    select j.data from jobs j where j.next_run_at <= now() and (j.status='pending' or (j.status='processing' and (j.lease_until is null or j.lease_until <= now())))
      and (j.data->>'kind'!='incoming' or not exists (
        select 1 from jobs earlier where earlier.company_id=j.company_id
          and earlier.data->>'kind'='incoming' and earlier.status!='done'
          and earlier.data->'payload'->>'phone' is not distinct from j.data->'payload'->>'phone'
          and earlier.arrival_sequence<j.arrival_sequence
      ))
    order by j.next_run_at,j.arrival_sequence limit least(greatest(p_limit,1),100)
  ) due;
$$;
create function public.claim_job(p_id text, p_now timestamptz, p_lease_until timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare claimed jsonb; target jobs%rowtype;
begin
  if p_now is null or p_lease_until is null or p_lease_until <= p_now then raise exception 'Invalid job lease'; end if;
  select * into target from jobs where id=p_id;
  if not found then return null; end if;
  if target.data->>'kind'='incoming' then
    perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array('orderly-incoming',target.company_id,target.data->'payload'->>'phone')::text,0));
  end if;
  update jobs j set status='processing',attempts=j.attempts+1,lease_until=p_lease_until,
    data=j.data || jsonb_build_object('status','processing','attempts',j.attempts+1,'leaseUntil',p_lease_until)
    where j.id=p_id and j.next_run_at<=p_now and (j.status='pending' or (j.status='processing' and (j.lease_until is null or j.lease_until<=p_now)))
      and (j.data->>'kind'!='incoming' or not exists (
        select 1 from jobs earlier where earlier.company_id=j.company_id
          and earlier.data->>'kind'='incoming' and earlier.status!='done'
          and earlier.data->'payload'->>'phone' is not distinct from j.data->'payload'->>'phone'
          and earlier.arrival_sequence<j.arrival_sequence
      ))
    returning j.data into claimed;
  return claimed;
end $$;
create function public.acquire_conversation_lock(p_company_id text,p_conversation_id text,p_owner_id text,p_lease_until timestamptz) returns boolean language plpgsql security definer set search_path = public as $$
declare claimed integer;
begin
  if p_lease_until <= now() or p_lease_until is null or p_owner_id is null or p_owner_id = '' then raise exception 'Invalid conversation lease'; end if;
  insert into conversation_locks(company_id,conversation_id,owner_id,lease_until) values(p_company_id,p_conversation_id,p_owner_id,p_lease_until)
    on conflict(company_id,conversation_id) do update set owner_id=excluded.owner_id,lease_until=excluded.lease_until
    where conversation_locks.lease_until <= now() or conversation_locks.owner_id = p_owner_id;
  get diagnostics claimed = row_count; return claimed = 1;
end $$;
create function public.release_conversation_lock(p_company_id text,p_conversation_id text,p_owner_id text) returns void language sql security definer set search_path = public as $$
  delete from conversation_locks where company_id=p_company_id and conversation_id=p_conversation_id and owner_id=p_owner_id;
$$;

-- Definer functions are an API-only capability, never callable with anon/browser keys.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('save_conversation','record_usage','insert_job','commit_turn','replace_products','save_integration','reserve_budget','settle_budget','list_due_jobs','claim_job','acquire_conversation_lock','release_conversation_lock','enforce_company_ownership','enforce_json_references') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;
revoke all on function public.is_platform_admin(), public.is_company_member(text) from public, anon;
grant execute on function public.is_platform_admin(), public.is_company_member(text) to authenticated, service_role;
