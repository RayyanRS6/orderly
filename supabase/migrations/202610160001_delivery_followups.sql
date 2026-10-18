-- Follow-ups from the WhatsApp delivery reviews. Apply after 202609200001. Safe to rerun only
-- until 202610180001_spam_protection.sql is applied: that file replaced this one's
-- fail_exhausted_orderly_jobs, so after it this file refuses to run rather than put back the older
-- version. Replaces three job functions from 202609110001 with the same bodies apart from the
-- marked changes, and adds one RPC.
do $$
begin
  if exists(select 1 from pg_proc where oid = to_regprocedure('public.fail_exhausted_orderly_jobs(integer)') and prosrc like '%limitPause%') then
    raise exception '202610160001_delivery_followups.sql is superseded by 202610180001_spam_protection.sql; do not re-run it';
  end if;
end $$;

-- Customer streams use the gateway's stream key, as insert_job, list_due_jobs and
-- claim_job already do (202609200001). A privacy-protected customer's first message can
-- arrive without a phone and later ones with it; matching on phone let dispatch skip the
-- next message until the minute's recovery pass, and held back other customers whose
-- phone was also unknown. (No new index: IS NOT DISTINCT FROM cannot use one, and
-- building it would block job writes while this script runs.)

create or replace function public.dispatch_orderly_job(p_job_id text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare selected_id text; worker_url text; worker_token text; request_id bigint;
begin
  if not public.orderly_scheduler_ready() then return null; end if;
  -- SKIP LOCKED plus the timestamp makes racing app/cron calls cheap. claim_job
  -- remains the authority for processing, attempts, expired leases and FIFO.
  select j.id into selected_id from public.jobs j
  where j.id = p_job_id and j.next_run_at <= now() and j.attempts < 5
    and (j.status = 'pending' or (j.status = 'processing' and (j.lease_until is null or j.lease_until <= now())))
    and (j.last_dispatched_at is null or j.last_dispatched_at <= now() - interval '45 seconds')
    and (j.data->>'kind' != 'incoming' or not exists (
      select 1 from public.jobs earlier where earlier.company_id = j.company_id
        and earlier.data->>'kind' = 'incoming' and earlier.status != 'done'
        and coalesce(earlier.data->'payload'->>'streamKey', earlier.data->'payload'->>'phone')
          is not distinct from coalesce(j.data->'payload'->>'streamKey', j.data->'payload'->>'phone')
        and earlier.arrival_sequence < j.arrival_sequence
    ))
  for update of j skip locked;
  if selected_id is null then return null; end if;
  select decrypted_secret into worker_url from vault.decrypted_secrets where name = 'orderly_worker_url';
  select decrypted_secret into worker_token from vault.decrypted_secrets where name = 'orderly_worker_token';
  request_id := net.http_post(
    url := worker_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || worker_token),
    body := jsonb_build_object('jobId', selected_id),
    timeout_milliseconds := 10000
  );
  update public.jobs set last_dispatched_at = now() where id = selected_id;
  return request_id;
end;
$$;

create or replace function public.recover_orderly_jobs(p_limit integer default 20) returns integer
language plpgsql security definer set search_path = '' as $$
declare target record; dispatched integer := 0;
begin
  perform public.fail_exhausted_orderly_jobs(p_limit);
  if not public.orderly_scheduler_ready() then return 0; end if;
  for target in
    select j.id from public.jobs j
    where j.next_run_at <= now() and j.attempts < 5
      and (j.status = 'pending' or (j.status = 'processing' and (j.lease_until is null or j.lease_until <= now())))
      and (j.last_dispatched_at is null or j.last_dispatched_at <= now() - interval '45 seconds')
      and (j.data->>'kind' != 'incoming' or not exists (
        select 1 from public.jobs earlier where earlier.company_id = j.company_id
          and earlier.data->>'kind' = 'incoming' and earlier.status != 'done'
          and coalesce(earlier.data->'payload'->>'streamKey', earlier.data->'payload'->>'phone')
            is not distinct from coalesce(j.data->'payload'->>'streamKey', j.data->'payload'->>'phone')
          and earlier.arrival_sequence < j.arrival_sequence
      ))
    order by j.next_run_at, j.arrival_sequence
    limit least(greatest(coalesce(p_limit, 20), 0), 20)
    for update of j skip locked
  loop
    begin
      if public.dispatch_orderly_job(target.id) is not null then dispatched := dispatched + 1; end if;
    exception when others then
      -- A dispatch failure must not roll back other requests in this batch.
      raise warning 'Orderly job dispatch unavailable; saved work will be retried';
    end;
  end loop;
  return dispatched;
end;
$$;

-- Unblock a customer's next message immediately after the earlier job commits.
-- Failed incoming jobs intentionally remain barriers until an operator retries.
create or replace function public.dispatch_next_orderly_incoming() returns trigger
language plpgsql security definer set search_path = '' as $$
declare next_id text;
begin
  select j.id into next_id from public.jobs j
    where j.company_id = new.company_id and j.data->>'kind' = 'incoming' and j.status != 'done'
      and coalesce(j.data->'payload'->>'streamKey', j.data->'payload'->>'phone')
        is not distinct from coalesce(new.data->'payload'->>'streamKey', new.data->'payload'->>'phone')
    order by j.arrival_sequence limit 1;
  if next_id is not null then perform public.dispatch_orderly_job(next_id); end if;
  return new;
exception when others then
  -- Preserve completion even when the notification transport is unavailable.
  raise warning 'Orderly follow-up dispatch unavailable; scheduled recovery will retry';
  return new;
end;
$$;

-- Runtime termination skips the worker's catch block. Finish exhausted leases in
-- the database so a CPU/time-limit failure cannot spend invocations indefinitely.
-- Changed: a linked-device customer's chat is found by its WhatsApp address (the phone
-- may be empty and shared by several customers), the bot-off pause mark is cleared as
-- the worker does, and a reply that was never sent is shown as "Not delivered".
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
        data = (c.data - 'botPausedAt') || jsonb_build_object('mode', 'human', 'version', c.version + 1,
          'updatedAt', to_char(failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        where c.id = failed_conversation_id and c.company_id = target.company_id
          and (c.data->>'mode' = 'bot' or c.data ? 'botPausedAt');
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

-- Stamping the menu sync time used to re-save the whole company, which could undo a
-- concurrent settings change such as switching the bot off. Only this field changes,
-- and only forwards.
create or replace function public.mark_catalog_synced(p_company_id text, p_synced_at timestamptz)
returns void language sql security definer set search_path = public as $$
  update companies
    set data = jsonb_set(data, '{catalogSyncedAt}',
      to_jsonb(to_char(p_synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    where id = p_company_id
      and coalesce((data->>'catalogSyncedAt')::timestamptz, '-infinity'::timestamptz) < p_synced_at;
$$;

revoke all on function public.dispatch_orderly_job(text), public.recover_orderly_jobs(integer),
  public.dispatch_next_orderly_incoming(), public.fail_exhausted_orderly_jobs(integer),
  public.mark_catalog_synced(text, timestamptz) from public, anon, authenticated;
grant execute on function public.dispatch_orderly_job(text), public.recover_orderly_jobs(integer),
  public.dispatch_next_orderly_incoming(), public.fail_exhausted_orderly_jobs(integer),
  public.mark_catalog_synced(text, timestamptz) to service_role;
