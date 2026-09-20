-- Private transport records. Pairing secrets/auth keys never enter this database.
create table public.gateway_nonces(nonce text primary key, expires_at timestamptz not null);
alter table public.gateway_nonces enable row level security;
revoke all on public.gateway_nonces from public, anon, authenticated;
grant all on public.gateway_nonces to service_role;
create function public.consume_gateway_nonce(p_nonce text) returns boolean language plpgsql security definer set search_path=public as $$
begin
  delete from gateway_nonces where expires_at<now();
  insert into gateway_nonces values(p_nonce,now()+interval '2 minutes') on conflict do nothing;
  return found;
end $$;
revoke all on function public.consume_gateway_nonce(text) from public,anon,authenticated;
grant execute on function public.consume_gateway_nonce(text) to service_role;
create table public.whatsapp_connections (
  id text primary key,
  company_id text not null unique references public.companies(id) on delete cascade,
  revision integer not null,
  data jsonb not null,
  check (data->>'id' = id and data->>'companyId' = company_id),
  check ((data->>'revision')::integer = revision),
  check ((data->>'generation')::integer > 0),
  check (data->>'provider' in ('meta','baileys'))
);
create unique index whatsapp_account_unique on public.whatsapp_connections ((data->>'accountJid'))
  where data->>'status' not in ('disconnected','logged_out') and data->>'accountJid' is not null;
alter table public.whatsapp_connections enable row level security;
revoke all on public.whatsapp_connections from anon, authenticated;
grant all on public.whatsapp_connections to service_role;

create function public.save_whatsapp_connection(p_connection jsonb, p_expected_revision integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare current_row whatsapp_connections%rowtype;
begin
  perform 1 from companies where id=p_connection->>'companyId' for update;
  if not found then raise exception 'Unknown company'; end if;
  select * into current_row from whatsapp_connections where company_id=p_connection->>'companyId' for update;
  if coalesce(current_row.revision,0) != p_expected_revision then return false; end if;
  if (p_connection->>'revision')::integer != p_expected_revision+1 then raise exception 'Invalid revision'; end if;
  if current_row.id is not null and (current_row.id != p_connection->>'id' or (p_connection->>'generation')::integer < (current_row.data->>'generation')::integer) then raise exception 'Invalid connection transition'; end if;
  insert into whatsapp_connections(id,company_id,revision,data)
    values(p_connection->>'id',p_connection->>'companyId',(p_connection->>'revision')::integer,p_connection)
    on conflict(company_id) do update set revision=excluded.revision,data=excluded.data;
  return true;
end $$;
-- Scope FIFO ordering to a connection generation and native identity. Legacy
-- official jobs continue using their original phone-number stream key.
do $$
declare fn regprocedure; definition text;
begin
  foreach fn in array array['public.insert_job(jsonb,text)'::regprocedure,'public.list_due_jobs(integer)'::regprocedure,'public.claim_job(text,timestamptz,timestamptz)'::regprocedure] loop
    definition := pg_get_functiondef(fn);
    definition := replace(definition, 'p_job->''payload''->>''phone''', 'coalesce(p_job->''payload''->>''streamKey'',p_job->''payload''->>''phone'')');
    definition := replace(definition, 'target.data->''payload''->>''phone''', 'coalesce(target.data->''payload''->>''streamKey'',target.data->''payload''->>''phone'')');
    definition := replace(definition, 'earlier.data->''payload''->>''phone''', 'coalesce(earlier.data->''payload''->>''streamKey'',earlier.data->''payload''->>''phone'')');
    definition := replace(definition, 'j.data->''payload''->>''phone''', 'coalesce(j.data->''payload''->>''streamKey'',j.data->''payload''->>''phone'')');
    execute definition;
  end loop;
end $$;
revoke all on function public.save_whatsapp_connection(jsonb,integer) from public, anon, authenticated;
grant execute on function public.save_whatsapp_connection(jsonb,integer) to service_role;

-- Existing official conversations retain their legacy namespace. New connections
-- get an explicit immutable routing namespace; a LID is never stored as a phone.
alter table public.conversations drop constraint conversations_company_id_customer_phone_channel_key;
create unique index conversations_transport_identity on public.conversations
  (company_id, channel, (coalesce(data->'whatsappAddress'->>'connectionId','')),
   (coalesce(data->'whatsappAddress'->>'generation','')),
   (coalesce(data->'whatsappAddress'->>'peer',customer_phone)));

create or replace function public.save_conversation(p_conversation jsonb, p_expected_version integer default null) returns boolean
language plpgsql security definer set search_path=public as $$
declare current_row conversations%rowtype; c_id text := p_conversation->>'id'; tenant text := p_conversation->>'companyId';
begin
  perform 1 from companies where id=tenant for update;
  if not found then raise exception 'Unknown company'; end if;
  select * into current_row from conversations where id=c_id for update;
  if found and current_row.company_id != tenant then raise exception 'Cross-company conversation'; end if;
  if current_row.id is not null and current_row.data->'whatsappAddress' is distinct from p_conversation->'whatsappAddress' then raise exception 'Cannot change conversation transport'; end if;
  if exists(select 1 from conversations where company_id=tenant and channel=p_conversation->>'channel' and id!=c_id
    and coalesce(data->'whatsappAddress'->>'connectionId','')=coalesce(p_conversation->'whatsappAddress'->>'connectionId','')
    and coalesce(data->'whatsappAddress'->>'generation','')=coalesce(p_conversation->'whatsappAddress'->>'generation','')
    and coalesce(data->'whatsappAddress'->>'peer',customer_phone)=coalesce(p_conversation->'whatsappAddress'->>'peer',p_conversation->>'customerPhone')) then return false; end if;
  if p_expected_version is not null then
    if coalesce(current_row.version,0)!=p_expected_version then return false; end if;
    if (p_conversation->>'version')::integer!=p_expected_version+1 then raise exception 'Conversation version must advance by one'; end if;
  end if;
  insert into conversations(id,company_id,customer_phone,channel,version,updated_at,data)
    values(c_id,tenant,p_conversation->>'customerPhone',p_conversation->>'channel',(p_conversation->>'version')::integer,(p_conversation->>'updatedAt')::timestamptz,p_conversation)
    on conflict(id) do update set customer_phone=excluded.customer_phone,channel=excluded.channel,version=excluded.version,updated_at=excluded.updated_at,data=excluded.data;
  return true;
end $$;
