-- Public menu page, phase 1: one fixed menu link per business (/m/<slug>). Apply after
-- 202610180001_spam_protection.sql and before deploying the code that reads menu_links.
-- Additive only: the code running now never touches these objects. Safe to rerun.
set lock_timeout = '5s';

create table if not exists public.menu_links (
  company_id text primary key references public.companies(id) on delete cascade,
  slug text not null unique,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_links_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80)
);
alter table public.menu_links enable row level security;
revoke all on public.menu_links from public, anon, authenticated;
grant all on public.menu_links to service_role;

-- Switches the link on or off. The slug is chosen the first time and never changes, so printed
-- QR codes keep working after the business is renamed. A taken slug gets a number on the end.
create or replace function public.set_menu_link(p_company_id text, p_enabled boolean, p_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare chosen text; attempt integer := 1; saved public.menu_links%rowtype;
begin
  if p_enabled is null then raise exception 'Invalid menu link state'; end if;
  perform 1 from companies where id = p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  update menu_links set enabled = p_enabled, updated_at = now()
    where company_id = p_company_id returning * into saved;
  if not found then
    if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) not between 3 and 72 then
      raise exception 'Invalid menu link';
    end if;
    chosen := p_slug;
    loop
      begin
        insert into menu_links(company_id, slug, enabled) values (p_company_id, chosen, p_enabled)
          returning * into saved;
        exit;
      exception when unique_violation then
        attempt := attempt + 1;
        if attempt > 50 then raise exception 'Could not choose a free menu link'; end if;
        chosen := p_slug || '-' || attempt;
      end;
    end loop;
  end if;
  return jsonb_build_object('companyId', saved.company_id, 'slug', saved.slug, 'enabled', saved.enabled,
    'updatedAt', to_char(saved.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname = any(array['set_menu_link']) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
