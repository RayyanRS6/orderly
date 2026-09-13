-- Apply after the initial two migrations; safe to rerun independently.
-- Supabase documents pg_cron in pg_catalog; pg_net creates its own net schema.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Dispatch metadata is deliberately separate from the job's processing lease.
alter table public.jobs add column if not exists last_dispatched_at timestamptz;
revoke all on vault.secrets, vault.decrypted_secrets from public, anon, authenticated;
revoke all on net.http_request_queue, net._http_response from public, anon, authenticated;

create or replace function public.orderly_scheduler_ready() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from vault.decrypted_secrets where name = 'orderly_worker_url'
      and decrypted_secret ~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/orderly/api/jobs/process$'
  ) and exists (
    select 1 from vault.decrypted_secrets where name = 'orderly_worker_token'
      and length(decrypted_secret) between 32 and 512 and decrypted_secret ~ '^[A-Za-z0-9_+/=-]+$'
  );
$$;

-- Configure after deploying the worker with the same CRON_SECRET. Never store a
-- key in cron.job.command, migrations, or browser-visible application tables.
create or replace function public.configure_orderly_scheduler(p_worker_url text, p_worker_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare secret_id uuid;
begin
  if p_worker_url is null or p_worker_url !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/orderly/api/jobs/process$' then
    raise exception 'Worker URL must be the HTTPS Orderly endpoint on a Supabase project';
  end if;
  if p_worker_token is null or length(p_worker_token) not between 32 and 512 or p_worker_token !~ '^[A-Za-z0-9_+/=-]+$' then
    raise exception 'Worker token must contain 32 to 512 URL-safe or base64 characters';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('orderly-scheduler-config', 0));
  select id into secret_id from vault.secrets where name = 'orderly_worker_url';
  if secret_id is null then
    perform vault.create_secret(p_worker_url, 'orderly_worker_url', 'Orderly durable job worker endpoint');
  else
    perform vault.update_secret(secret_id, p_worker_url);
  end if;
  select id into secret_id from vault.secrets where name = 'orderly_worker_token';
  if secret_id is null then
    perform vault.create_secret(p_worker_token, 'orderly_worker_token', 'Must match the worker CRON_SECRET');
  else
    perform vault.update_secret(secret_id, p_worker_token);
  end if;
  return public.orderly_scheduler_ready();
end;
$$;

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
        and earlier.data->'payload'->>'phone' is not distinct from j.data->'payload'->>'phone'
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

-- Runtime termination skips the worker's catch block. Finish exhausted leases in
-- the database so a CPU/time-limit failure cannot spend invocations indefinitely.
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
      select c.id into failed_conversation_id from public.conversations c
        where c.company_id = target.company_id and c.channel = 'whatsapp'
          and c.customer_phone = target.data->'payload'->>'phone'
        for update of c;
      -- Preserve every other field and advance both representations of version.
      update public.conversations c set version = c.version + 1, updated_at = failed_at,
        data = c.data || jsonb_build_object('mode', 'human', 'version', c.version + 1,
          'updatedAt', to_char(failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        where c.id = failed_conversation_id and c.company_id = target.company_id
          and c.data->>'mode' = 'bot';
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
          and earlier.data->'payload'->>'phone' is not distinct from j.data->'payload'->>'phone'
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
      and j.data->'payload'->>'phone' is not distinct from new.data->'payload'->>'phone'
    order by j.arrival_sequence limit 1;
  if next_id is not null then perform public.dispatch_orderly_job(next_id); end if;
  return new;
exception when others then
  -- Preserve completion even when the notification transport is unavailable.
  raise warning 'Orderly follow-up dispatch unavailable; scheduled recovery will retry';
  return new;
end;
$$;
drop trigger if exists orderly_incoming_completed on public.jobs;
create trigger orderly_incoming_completed after update of status on public.jobs
for each row when (old.status != 'done' and new.status = 'done' and new.data->>'kind' = 'incoming')
execute function public.dispatch_next_orderly_incoming();

create or replace function public.prune_orderly_cron_history() returns integer
language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  delete from cron.job_run_details where runid in (
    select details.runid from cron.job_run_details details join cron.job scheduled using (jobid)
    where scheduled.jobname in ('orderly-recover-jobs', 'orderly-prune-cron-history')
      and details.end_time < now() - interval '3 days'
    order by details.end_time limit 10000
  );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.orderly_scheduler_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'configured', public.orderly_scheduler_ready(),
    'workerUrlConfigured', exists (select 1 from vault.secrets where name = 'orderly_worker_url'),
    'workerTokenConfigured', exists (select 1 from vault.secrets where name = 'orderly_worker_token'),
    'recoveryScheduled', exists (select 1 from cron.job where jobname = 'orderly-recover-jobs' and active),
    'batchSize', 20,
    'dispatchThrottleSeconds', 45
  );
$$;

revoke all on function public.orderly_scheduler_ready(), public.configure_orderly_scheduler(text,text),
  public.dispatch_orderly_job(text), public.fail_exhausted_orderly_jobs(integer), public.recover_orderly_jobs(integer), public.dispatch_next_orderly_incoming(),
  public.prune_orderly_cron_history(), public.orderly_scheduler_status() from public, anon, authenticated;
grant execute on function public.orderly_scheduler_ready(), public.configure_orderly_scheduler(text,text),
  public.dispatch_orderly_job(text), public.fail_exhausted_orderly_jobs(integer), public.recover_orderly_jobs(integer), public.dispatch_next_orderly_incoming(),
  public.prune_orderly_cron_history(), public.orderly_scheduler_status() to service_role;

-- Named cron.schedule calls update existing jobs on a rerun. Without Vault
-- configuration the minute job only checks saved jobs and database readiness.
select cron.schedule('orderly-recover-jobs', '* * * * *', 'select public.recover_orderly_jobs(20);');
select cron.schedule('orderly-prune-cron-history', '17 * * * *', 'select public.prune_orderly_cron_history();');
