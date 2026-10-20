-- The shorter order flow: Accept takes a new order straight to 'preparing' (there is no separate
-- 'accepted' step any more), then a pickup order becomes 'ready' and a delivery order goes
-- 'out_for_delivery', and either one is 'completed'. Staff no longer record a call outcome before
-- accepting; an optional staff note can be saved with the status change (data.staffNote, at most
-- 500 characters). Also the counts the Orders page shows on its Pending, Ready and Out for
-- delivery tabs. Data: orders still 'accepted' become 'preparing' (their updatedAt is kept, so
-- the customer's "Last update" stays true), and status notices still waiting to be sent for them
-- say 'preparing' too, or the worker would drop them as out of date.
-- Apply after 202610200002_order_followups.sql and before deploying the backend that calls
-- set_order_status and order_status_counts. The backend and dashboard running now keep working:
-- update_order_status, record_call and the confirm_before_accept trigger are left as they are
-- (the trigger only acts on a change to 'accepted', which the new backend never makes), and no
-- function changes its signature. A later file may drop them once no older backend can run.
-- Safe to rerun: a rerun finds no 'accepted' orders left to change.
set lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.queue_order_followups()') is null then
    raise exception 'Apply 202610200002_order_followups.sql before 202610200003_order_flow.sql';
  end if;
end $$;

-- update_order_status (202609160001) with the new steps. A pickup order is never 'out for
-- delivery'. The dashboard takes a delivery order from preparing out for delivery; preparing ->
-- ready stays allowed for one, because a dashboard from before this flow, still open, offers only
-- that (then ready -> out for delivery). 'accepted' is accepted only as an order's current
-- status, from before this flow. p_note, when given, is saved as data.staffNote.
create or replace function public.set_order_status(p_company_id text,p_id text,p_expected_status text,p_new_status text,p_now timestamptz,p_jobs jsonb default '[]',p_conversation jsonb default null,p_expected_version integer default null,p_note jsonb default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare result jsonb; j jsonb; current_conversation conversations%rowtype; fulfillment text;
begin
  if not (
    (p_expected_status='pending' and p_new_status in ('preparing','rejected','cancelled')) or
    (p_expected_status='accepted' and p_new_status in ('preparing','cancelled')) or
    (p_expected_status='preparing' and p_new_status in ('ready','out_for_delivery','cancelled')) or
    (p_expected_status='ready' and p_new_status in ('completed','out_for_delivery','cancelled')) or
    (p_expected_status='out_for_delivery' and p_new_status in ('completed','cancelled'))
  ) then raise exception 'Invalid order status transition'; end if;
  if p_note is not null and (jsonb_typeof(p_note)<>'object' or jsonb_typeof(p_note->'text')<>'string' or length(p_note->>'text') not between 1 and 500) then
    raise exception 'Invalid staff note';
  end if;
  select data->>'fulfillment' into fulfillment from orders where id=p_id and company_id=p_company_id;
  if p_new_status='out_for_delivery' and fulfillment is distinct from 'delivery' then raise exception 'Pickup orders cannot go out for delivery'; end if;
  if p_conversation is not null then
    if p_new_status!='cancelled' or p_expected_status!='pending' or p_conversation->>'companyId' is distinct from p_company_id then raise exception 'Invalid automatic cancellation'; end if;
    perform 1 from companies where id=p_company_id and (data->>'botEnabled'='true' or p_conversation->>'channel'='demo') for update;
    if not found then return null; end if;
    select * into current_conversation from conversations where id=p_conversation->>'id' and company_id=p_company_id for update;
    if not found or current_conversation.version is distinct from p_expected_version or current_conversation.data->>'mode' is distinct from 'bot' then return null; end if;
    if current_conversation.data->'cart'->>'orderId' is distinct from p_id then raise exception 'Invalid automatic cancellation order'; end if;
  end if;
  update orders set data=data||jsonb_build_object('status',p_new_status,'updatedAt',to_char(p_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ||case when p_note is not null then jsonb_build_object('staffNote',p_note) else '{}'::jsonb end
      ||case when exists(select 1 from jsonb_array_elements(p_jobs) sync_job where sync_job->>'kind'='sheet_sync') then '{"syncStatus":"pending"}'::jsonb else '{}'::jsonb end,updated_at=p_now
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

-- The orders staff still have to act on, by step, counted as workspace_summary counts its
-- 'pending' (sandbox chats or live ones).
create or replace function public.order_status_counts(p_company_id text,p_sandbox boolean) returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'pending',count(*) filter (where o.data->>'status'='pending'),
    'preparing',count(*) filter (where o.data->>'status' in ('preparing','accepted')),
    'ready',count(*) filter (where o.data->>'status'='ready'),
    'out_for_delivery',count(*) filter (where o.data->>'status'='out_for_delivery'))
  from orders o join conversations c on c.id=o.conversation_id and c.company_id=o.company_id
  where o.company_id=p_company_id and (c.channel='demo')=p_sandbox
    and o.data->>'status' in ('pending','accepted','preparing','ready','out_for_delivery');
$$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname=any(array['set_order_status','order_status_counts']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- Orders accepted before this flow are being prepared. The 'accepted' notices still waiting to be
-- sent (or failed, so a retry does not drop them) follow, only for the orders changed here: an
-- order that already moved on keeps its old notice out of date, so it is never sent late. A
-- connected Sheet shows 'preparing' at the order's next status change. Run the file again after
-- the new backend is live: the older one, running meanwhile, still accepts orders as 'accepted'.
with changed as (
  update public.orders set data=jsonb_set(data,'{status}','"preparing"')
    where data->>'status'='accepted' returning company_id, id
)
update public.jobs j set data=jsonb_set(j.data,'{payload,status}','"preparing"')
  from changed o
  where j.company_id=o.company_id and j.data->'payload'->>'orderId'=o.id
    and j.status in ('pending','failed') and j.data->>'kind'='whatsapp_send'
    and j.data->'payload'->>'status'='accepted';

insert into public.orderly_schema_migrations(name) values ('202610200003_order_flow.sql')
  on conflict (name) do nothing;
notify pgrst, 'reload schema';
