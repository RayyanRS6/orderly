-- All RPCs here are server-only. Browser writes remain forbidden.
-- The same opt-in MFA rule applies to direct PostgREST reads and the API.
create function public.mfa_access_allowed() returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and (auth.jwt()->>'aal'='aal2' or not exists(select 1 from auth.mfa_factors where user_id=auth.uid() and status='verified'));
$$;
revoke all on function public.mfa_access_allowed() from public,anon;
grant execute on function public.mfa_access_allowed() to authenticated,service_role;
do $$ declare t text; begin
  foreach t in array array['companies','platform_admins','company_memberships','products','conversations','orders','integrations','traces','usage_events'] loop
    execute format('create policy mfa_required on public.%I as restrictive for select to authenticated using ((select public.mfa_access_allowed()))',t);
  end loop;
end $$;
create function public.save_company_settings(p_company jsonb) returns void language sql security definer set search_path=public as $$
  insert into companies(id,slug,data,created_at) values(p_company->>'id',p_company->>'slug',p_company,(p_company->>'createdAt')::timestamptz)
  on conflict(id) do update set slug=excluded.slug,data=(excluded.data-'bot')||case when companies.data ? 'bot' then jsonb_build_object('bot',companies.data->'bot') else '{}'::jsonb end;
$$;
create table public.api_rate_limits (key text primary key, window_at timestamptz not null, count integer not null);
alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from public,anon,authenticated;
grant all on public.api_rate_limits to service_role;
create function public.consume_rate_limit(p_key text,p_limit integer) returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  insert into api_rate_limits values(p_key,date_trunc('minute',now()),1)
  on conflict(key) do update set window_at=date_trunc('minute',now()),count=case when api_rate_limits.window_at=date_trunc('minute',now()) then api_rate_limits.count+1 else 1 end returning count into n;
  delete from api_rate_limits where window_at<now()-interval '1 day';
  return n<=p_limit;
end $$;

-- History is append/update by message ID; the active conversation retains only 100 messages.
create table public.conversation_messages (
  company_id text not null, conversation_id text not null, id text not null, data jsonb not null, created_at timestamptz not null,
  primary key(company_id,conversation_id,id),
  foreign key(company_id,conversation_id) references public.conversations(company_id,id) on delete cascade deferrable initially deferred
);
create index conversation_messages_recent on public.conversation_messages(company_id,conversation_id,created_at desc,id);
alter table public.conversation_messages enable row level security;
revoke all on public.conversation_messages from public,anon,authenticated;
grant all on public.conversation_messages to service_role;
insert into conversation_messages select c.company_id,c.id,m->>'id',m,(m->>'createdAt')::timestamptz from conversations c cross join lateral jsonb_array_elements(c.data->'messages') m on conflict do nothing;
create function public.archive_messages() returns trigger language plpgsql set search_path=public as $$
begin
  insert into conversation_messages select new.company_id,new.id,m->>'id',m,(m->>'createdAt')::timestamptz from jsonb_array_elements(new.data->'messages') m on conflict(company_id,conversation_id,id) do update set data=excluded.data;
  new.data:=jsonb_set(new.data,'{messages}',coalesce((select jsonb_agg(m order by n) from jsonb_array_elements(new.data->'messages') with ordinality a(m,n) where n>jsonb_array_length(new.data->'messages')-100),'[]'));
  return new;
end $$;
create trigger archive_conversation_messages before insert or update on public.conversations for each row execute function public.archive_messages();
update conversations set data=data where jsonb_array_length(data->'messages')>100;

create function public.query_orders(p_company_id text,p_filter jsonb) returns jsonb language sql stable security definer set search_path=public as $$
  with opts as (select greatest(1,least(100,coalesce((p_filter->>'pageSize')::integer,50))) size,greatest(1,coalesce((p_filter->>'page')::integer,1)) page),
  matching as (select o.* from orders o join conversations c on c.id=o.conversation_id and c.company_id=o.company_id where o.company_id=p_company_id
    and (not p_filter ? 'sandbox' or (c.channel='demo')=(p_filter->>'sandbox')::boolean)
    and (coalesce(p_filter->>'status','all')='all' or o.data->>'status'=p_filter->>'status' or (p_filter->>'status'='active' and o.data->>'status' in ('pending','accepted','preparing','ready','out_for_delivery')))
    and (coalesce(p_filter->>'search','')='' or strpos(lower(concat_ws(' ',o.data->>'reference',o.data->>'customerName',o.data->>'customerPhone')),lower(p_filter->>'search'))>0)
    and (not p_filter ? 'from' or o.created_at>=(p_filter->>'from')::timestamptz) and (not p_filter ? 'to' or o.created_at<=(p_filter->>'to')::timestamptz)),
  page_rows as (select data from matching order by created_at desc,id desc limit (select size from opts) offset (select (page-1)*size from opts))
  select jsonb_build_object('items',coalesce((select jsonb_agg(data) from page_rows),'[]'),'total',(select count(*) from matching),'page',page,'pageSize',size) from opts;
$$;
create function public.query_conversations(p_company_id text,p_filter jsonb) returns jsonb language sql stable security definer set search_path=public as $$
  with opts as (select greatest(1,least(100,coalesce((p_filter->>'pageSize')::integer,50))) size,greatest(1,coalesce((p_filter->>'page')::integer,1)) page),
  matching as (select * from conversations where company_id=p_company_id and (not p_filter ? 'sandbox' or (channel='demo')=(p_filter->>'sandbox')::boolean)
    and (coalesce(p_filter->>'status','all')='all' or data->>'mode'=p_filter->>'status')
    and (coalesce(p_filter->>'search','')='' or strpos(lower(concat_ws(' ',data->>'customerName',customer_phone)),lower(p_filter->>'search'))>0)),
  page_rows as (select jsonb_set(data,'{messages}',case when jsonb_array_length(data->'messages')>0 then jsonb_build_array(data->'messages'->-1) else '[]'::jsonb end) data from matching order by updated_at desc,id desc limit (select size from opts) offset (select (page-1)*size from opts))
  select jsonb_build_object('items',coalesce((select jsonb_agg(data) from page_rows),'[]'),'total',(select count(*) from matching),'page',page,'pageSize',size) from opts;
$$;
create function public.conversation_history(p_company_id text,p_id text,p_page integer) returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('items',coalesce((select jsonb_agg(data) from (select data from conversation_messages where company_id=p_company_id and conversation_id=p_id order by created_at desc,id desc limit 100 offset (greatest(1,p_page)-1)*100) x),'[]'),'total',(select count(*) from conversation_messages where company_id=p_company_id and conversation_id=p_id),'page',greatest(1,p_page),'pageSize',100);
$$;
create function public.workspace_summary(p_company_id text,p_sandbox boolean) returns jsonb language sql stable security definer set search_path=public as $$
  with conv as (select * from conversations where company_id=p_company_id and (channel='demo')=p_sandbox), ord as (select o.* from orders o join conv c on c.id=o.conversation_id where o.company_id=p_company_id), days as (select d::date as day_date from generate_series(current_date-29,current_date,interval '1 day') d)
  select jsonb_build_object('orders',(select count(*) from ord),'pending',(select count(*) from ord where data->>'status'='pending'),'value',(select coalesce(sum((data->>'total')::numeric),0) from ord where data->>'status' not in ('cancelled','rejected')),'conversations',(select count(*) from conv),'needsStaff',(select count(*) from conv where data->>'mode'='human'),'monthlySpend',(select coalesce(sum(cost_usd),0) from usage_events where company_id=p_company_id and created_at>=date_trunc('month',now())),'daily',(select jsonb_agg(jsonb_build_object('date',day_date,'count',(select count(*) from ord where (created_at at time zone 'UTC')::date=day_date)) order by day_date) from days));
$$;

create function public.save_bot(p_company_id text,p_settings jsonb,p_revision integer) returns boolean language plpgsql security definer set search_path=public as $$
begin
  if (p_settings->>'revision')::integer<>p_revision+1 then raise exception 'Invalid revision'; end if;
  update companies set data=jsonb_set(data,'{bot}',p_settings) where id=p_company_id and coalesce((data->'bot'->>'revision')::integer,0)=p_revision;
  return found;
end $$;
create function public.record_call(p_company_id text,p_id text,p_confirmation jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  update orders set data=data||jsonb_build_object('phoneConfirmation',p_confirmation,'updatedAt',p_confirmation->>'at'),updated_at=(p_confirmation->>'at')::timestamptz where id=p_id and company_id=p_company_id and data->>'status'='pending' returning data into result;
  return result;
end $$;
-- Protect the call gate even if another server code path performs a status update.
create function public.enforce_call_confirmation() returns trigger language plpgsql set search_path=public as $$
begin
  if new.data->>'status'='accepted' and old.data->>'status'='pending' and old.data->>'phoneConfirmationRequired'='true' and (old.data->'phoneConfirmation'->>'outcome' is distinct from 'confirmed' or (old.data->>'fulfillment'='delivery' and old.data->'phoneConfirmation'->>'addressVerified' is distinct from 'true')) then raise exception 'Record phone and address confirmation before accepting'; end if;
  return new;
end $$;
create trigger confirm_before_accept before update on public.orders for each row execute function public.enforce_call_confirmation();

create function public.disconnect_integration(p_company_id text,p_kind text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from companies where id=p_company_id for update;
  if exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) or exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now()) then raise exception 'Wait for running work before disconnecting'; end if;
  delete from integrations where company_id=p_company_id and kind=p_kind;
  update jobs set status='done',lease_until=null,data=(data-'leaseUntil')||'{"status":"done","payload":{}}'::jsonb where company_id=p_company_id and ((p_kind='sheets' and data->>'kind'='sheet_sync') or (p_kind='whatsapp' and data->>'kind'!='sheet_sync'));
  update companies set data=(data-'modelVerification')||'{"botEnabled":false}'::jsonb where id=p_company_id;
end $$;
create function public.manage_member(p_company_id text,p_user_id uuid,p_role text,p_actor_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare previous text;
begin
  perform 1 from companies where id=p_company_id for update;
  select role into previous from company_memberships where company_id=p_company_id and user_id=p_user_id;
  if p_role is distinct from 'owner' and (p_user_id=p_actor_id or (previous='owner' and (select count(*) from company_memberships where company_id=p_company_id and role='owner')<=1)) then raise exception 'Keep another owner and do not remove or demote yourself'; end if;
  if p_role is null then delete from company_memberships where company_id=p_company_id and user_id=p_user_id;
  else insert into company_memberships values(p_company_id,p_user_id,p_role) on conflict(company_id,user_id) do update set role=excluded.role; end if;
end $$;
create function public.erase_customer(p_company_id text,p_phone text) returns integer language plpgsql security definer set search_path=public as $$
declare ids text[]; order_ids text[];
begin
  perform 1 from companies where id=p_company_id for update;
  if exists(select 1 from companies where id=p_company_id and data->>'botEnabled'='true') or exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) or exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now()) then raise exception 'Pause automation and wait for running work before deleting customer data'; end if;
  select array_agg(id) into ids from conversations where company_id=p_company_id and customer_phone=p_phone;
  select array_agg(id) into order_ids from orders where company_id=p_company_id and conversation_id=any(ids);
  -- Keep dedupe tombstones, remove payloads so webhook retries cannot restore deleted data.
  update jobs set status='done',lease_until=null,data=(data-'leaseUntil'-'lastError')||'{"status":"done","payload":{}}'::jsonb where company_id=p_company_id and (data->'payload'->>'phone'=p_phone or data->'payload'->>'conversationId'=any(ids) or data->'payload'->>'orderId'=any(order_ids));
  delete from traces where company_id=p_company_id and conversation_id=any(ids);
  update usage_events set data=data-'conversationId' where company_id=p_company_id and data->>'conversationId'=any(ids);
  delete from orders where company_id=p_company_id and conversation_id=any(ids);
  delete from conversations where company_id=p_company_id and id=any(ids);
  return coalesce(cardinality(ids),0);
end $$;

-- Administrative events are immutable, with no customer text or credentials.
create table public.audit_events(id bigint generated always as identity primary key,company_id text not null,actor_id text not null,action text not null,created_at timestamptz not null default now());
alter table public.audit_events enable row level security;
revoke all on public.audit_events from public,anon,authenticated,service_role;
grant select,insert on public.audit_events to service_role;
grant usage on sequence public.audit_events_id_seq to service_role;
create function public.audit_event(p_company_id text,p_actor_id text,p_action text) returns void language sql security definer set search_path=public as $$ insert into audit_events(company_id,actor_id,action) values(p_company_id,p_actor_id,left(p_action,200)); $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname=any(array['save_company_settings','consume_rate_limit','archive_messages','query_orders','query_conversations','conversation_history','workspace_summary','save_bot','record_call','enforce_call_confirmation','disconnect_integration','manage_member','erase_customer','audit_event']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- Sandbox ordering remains available while live automation is paused.
create or replace function public.update_order_status(p_company_id text,p_id text,p_expected_status text,p_new_status text,p_now timestamptz,p_jobs jsonb default '[]',p_conversation jsonb default null,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare result jsonb; j jsonb; current_conversation conversations%rowtype;
begin
  if not (
    (p_expected_status='pending' and p_new_status in ('accepted','rejected','cancelled')) or
    (p_expected_status='accepted' and p_new_status in ('preparing','cancelled')) or
    (p_expected_status='preparing' and p_new_status in ('ready','cancelled')) or
    (p_expected_status='ready' and p_new_status in ('completed','out_for_delivery','cancelled')) or
    (p_expected_status='out_for_delivery' and p_new_status in ('completed','cancelled'))
  ) then raise exception 'Invalid order status transition'; end if;
  if p_conversation is not null then
    if p_new_status!='cancelled' or p_expected_status!='pending' or p_conversation->>'companyId' is distinct from p_company_id then raise exception 'Invalid automatic cancellation'; end if;
    perform 1 from companies where id=p_company_id and (data->>'botEnabled'='true' or p_conversation->>'channel'='demo') for update;
    if not found then return null; end if;
    select * into current_conversation from conversations where id=p_conversation->>'id' and company_id=p_company_id for update;
    if not found or current_conversation.version is distinct from p_expected_version or current_conversation.data->>'mode' is distinct from 'bot' then return null; end if;
    if current_conversation.data->'cart'->>'orderId' is distinct from p_id then raise exception 'Invalid automatic cancellation order'; end if;
  end if;
  update orders set data=data||jsonb_build_object('status',p_new_status,'updatedAt',to_char(p_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||case when exists(select 1 from jsonb_array_elements(p_jobs) sync_job where sync_job->>'kind'='sheet_sync') then '{"syncStatus":"pending"}'::jsonb else '{}'::jsonb end,updated_at=p_now
    where id=p_id and company_id=p_company_id and data->>'status'=p_expected_status and (p_conversation is null or conversation_id=p_conversation->>'id') returning data into result;
  if result is null then return null; end if;
  if p_conversation is not null then
    if not save_conversation(p_conversation,p_expected_version) then raise exception 'Conversation changed during cancellation'; end if;
  end if;
  for j in select value from jsonb_array_elements(p_jobs) loop
    if j->>'companyId' is distinct from p_company_id then raise exception 'Cross-company job'; end if;
    perform insert_job(j);
  end loop;
  return result;
end $$;

-- Sandbox ordering remains available while live automation is paused.
create or replace function public.validate_order_snapshot() returns trigger language plpgsql set search_path=public as $$
declare line jsonb; product jsonb; business jsonb; opt jsonb; unit numeric; subtotal numeric:=0; fee numeric:=0; quantity integer; option_name text;
begin
  select data into business from companies where id=new.company_id for share;
  if business->>'botEnabled' is distinct from 'true' and not exists(select 1 from conversations where id=new.conversation_id and company_id=new.company_id and channel='demo') then raise exception 'Automatic ordering is paused'; end if;
  if new.data->>'status'!='pending' then raise exception 'New orders must await staff acceptance'; end if;
  if jsonb_array_length(new.data->'items')=0 then raise exception 'Empty order'; end if;
  for line in select value from jsonb_array_elements(new.data->'items') loop
    select data into product from products where id=line->>'productId' and company_id=new.company_id for share;
    if product is null or not (product->>'available')::boolean then raise exception 'Catalog changed: item unavailable'; end if;
    quantity:=(line->>'quantity')::integer;
    if quantity<1 or quantity>50 then raise exception 'Invalid quantity'; end if;
    unit:=(product->>'price')::numeric;
    if jsonb_array_length(coalesce(product->'variants','[]'))>0 then
      select value into opt from jsonb_array_elements(product->'variants') where value->>'name'=line->>'variant';
      if opt is null then raise exception 'Catalog changed: invalid variant'; end if;
      unit:=(opt->>'price')::numeric;
    elsif line->>'variant' is not null then raise exception 'Invalid variant'; end if;
    for option_name in select jsonb_array_elements_text(coalesce(line->'modifiers','[]')) loop
      select value into opt from jsonb_array_elements(product->'modifiers') where value->>'name'=option_name;
      if opt is null then raise exception 'Catalog changed: invalid modifier'; end if;
      unit:=unit+(opt->>'price')::numeric;
    end loop;
    if unit!=(line->>'unitPrice')::numeric or unit*quantity!=(line->>'total')::numeric then raise exception 'Catalog price changed: review again'; end if;
    subtotal:=subtotal+unit*quantity;
  end loop;
  if new.data->>'fulfillment'='delivery' then
    select (value->>'fee')::numeric into fee from jsonb_array_elements(business->'deliveryZones') where lower(value->>'name')=lower(new.data->>'zone');
    if fee is null or length(coalesce(new.data->>'address',''))=0 then raise exception 'Invalid delivery details'; end if;
  elsif new.data->>'fulfillment'!='pickup' then raise exception 'Invalid fulfillment'; end if;
  if length(coalesce(new.data->>'customerName',''))=0 then raise exception 'Customer name required'; end if;
  if subtotal!=(new.data->>'subtotal')::numeric or fee!=(new.data->>'deliveryFee')::numeric or subtotal+fee!=(new.data->>'total')::numeric then raise exception 'Order total changed: review again'; end if;
  return new;
end $$;
