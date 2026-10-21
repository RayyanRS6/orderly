// Every migration in filename order in PGlite, with pg_cron, pg_net and Vault stubbed, as for a
// new installation. Each SQL test file gets its own database.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { seedCompanies, seedProducts } from '../../src/shared/seed';

const files = readdirSync('supabase/migrations').sort();
const migration = (file: string) =>
  readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/^create extension [^;]+;\r?$/gm, '');

export async function migratedDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
    create table auth.mfa_factors(id uuid primary key, user_id uuid, status text);
    create function auth.jwt() returns jsonb language sql stable as $$ select '{"aal":"aal1"}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    grant execute on function auth.uid() to authenticated, service_role;
    create schema vault;
    create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text);
    create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as $$
      insert into vault.secrets(name,secret) values(new_name,new_secret) returning id;
    $$;
    create function vault.update_secret(secret_id uuid, new_secret text) returns void language sql as $$
      update vault.secrets set secret=new_secret where id=secret_id;
    $$;
    create schema net;
    create table net.http_request_queue(id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
    create table net._http_response(id bigint, status_code integer, timed_out boolean, error_msg text, created timestamptz default now());
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 2000)
    returns bigint language sql as $$
      insert into net.http_request_queue(url,body,headers,timeout_milliseconds) values(url,body,headers,timeout_milliseconds) returning id;
    $$;
    create schema cron;
    create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
    create table cron.job_run_details(runid bigserial primary key, jobid bigint, status text, end_time timestamptz);
    create function cron.schedule(job_name text, job_schedule text, job_command text) returns bigint language sql as $$
      insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid;
    $$;
  `);
  for (const file of files) await db.exec(migration(file));
  async function scalar<T = unknown>(text: string, args: unknown[] = []) {
    return (await db.query<{ value: T }>(text, args)).rows[0]?.value as T;
  }
  const rpc = <T = unknown>(name: string, args: unknown[] = []) =>
    scalar<T>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`, args);
  // The seed businesses and their menus, and nothing else.
  async function reset() {
    await db.exec(`reset role; truncate public.companies cascade;
      truncate public.deleted_companies, public.deleted_whatsapp_connections;
      truncate vault.secrets, net.http_request_queue, net._http_response, cron.job_run_details;`);
    for (const c of seedCompanies)
      await db.query('insert into companies(id,slug,data) values($1,$2,$3)', [c.id, c.slug, c]);
    for (const p of seedProducts)
      await db.query('insert into products(id,company_id,data) values($1,$2,$3)', [
        p.id,
        p.companyId,
        p,
      ]);
  }
  return { db, scalar, rpc, reset };
}
