-- Reminds a customer whose order is still waiting for the restaurant. Every 5 minutes, each live
-- WhatsApp order still pending 15 minutes after it was placed (and placed within the last 3
-- hours, so the first run does not remind customers of orders staff handled hours ago without
-- pressing Accept) gets one 'order_followup' job, payload {orderId, conversationId}; the worker
-- checks the order again before it writes to the customer. Staff are reminded by the bell and,
-- since 202610200001, by email alerts after at most 15 minutes.
-- Apply after 202610200001_prelaunch_fixes.sql and only once the backend that handles
-- 'order_followup' jobs is live: an older worker does not know them and ends each one as a
-- failed job (a staff alert) or as done, unsent.
-- The job functions need no change: claim_job, list_due_jobs, dispatch_orderly_job,
-- recover_orderly_jobs and fail_exhausted_orderly_jobs treat every kind but 'incoming' alike.
-- Safe to rerun.
set lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.orderly_pipeline_health()') is null then
    raise exception 'Apply 202610200001_prelaunch_fixes.sql before 202610200002_order_followups.sql';
  end if;
end $$;

create index if not exists orders_pending_followup on public.orders(created_at)
  where data->>'status' = 'pending' and data->>'sandbox' = 'false';

-- One job per order ever ('order-followup:<order id>' is its duplicate key). Orders already
-- queued are skipped before the limit, so a backlog never holds back newer orders.
create or replace function public.queue_order_followups() returns integer
language plpgsql security definer set search_path = public as $$
declare target record; total integer := 0;
  stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  -- Nothing could send them yet; they are queued once the worker is set up.
  if not orderly_scheduler_ready() then return 0; end if;
  for target in
    select o.id, o.company_id, o.conversation_id from orders o
      join conversations c on c.company_id = o.company_id and c.id = o.conversation_id
    where o.data->>'status' = 'pending' and o.data->>'sandbox' = 'false'
      and o.created_at < now() - interval '15 minutes' and o.created_at > now() - interval '3 hours'
      and c.channel = 'whatsapp' and jsonb_typeof(c.data->'blocked') is distinct from 'object'
      and not exists(select 1 from jobs j where j.dedupe_key = 'order-followup:' || o.id)
    order by o.created_at, o.id limit 100
  loop
    if insert_job(jsonb_build_object('id', gen_random_uuid()::text, 'companyId', target.company_id,
        'kind', 'order_followup',
        'payload', jsonb_build_object('orderId', target.id, 'conversationId', target.conversation_id),
        'status', 'pending', 'attempts', 0, 'nextRunAt', stamp, 'createdAt', stamp),
      'order-followup:' || target.id) then
      total := total + 1;
    end if;
  end loop;
  return total;
end $$;

-- Latest body from 202609180001_email_alerts.sql. Changed: disconnecting WhatsApp also ends the
-- reminders still waiting to be sent, as it ends the messages waiting to be sent.
create or replace function public.disconnect_integration(p_company_id text,p_kind text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from companies where id=p_company_id for update;
  if exists(select 1 from jobs where company_id=p_company_id and status='processing' and lease_until>now()) or exists(select 1 from conversation_locks where company_id=p_company_id and lease_until>now()) then raise exception 'Wait for running work before disconnecting'; end if;
  delete from integrations where company_id=p_company_id and kind=p_kind;
  update jobs set status='done',lease_until=null,data=(data-'leaseUntil')||'{"status":"done","payload":{}}'::jsonb where company_id=p_company_id and ((p_kind='sheets' and data->>'kind'='sheet_sync') or (p_kind='whatsapp' and data->>'kind' in ('incoming','whatsapp_send','order_followup')));
  update companies set data=(data-'modelVerification')||'{"botEnabled":false}'::jsonb where id=p_company_id;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname=any(array['queue_order_followups','disconnect_integration']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

-- A named schedule is updated on a rerun.
select cron.schedule('orderly-order-followups', '*/5 * * * *', 'select public.queue_order_followups()');

insert into public.orderly_schema_migrations(name) values ('202610200002_order_followups.sql')
  on conflict (name) do nothing;
notify pgrst, 'reload schema';
