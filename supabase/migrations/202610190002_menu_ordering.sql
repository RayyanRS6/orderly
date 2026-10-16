-- Menu page ordering: personal one-tap links and Instagram/QR order codes. Apply after
-- 202610190001_menu_page.sql (and 202610180001_spam_protection.sql, which created
-- blocked_customers) and before deploying the code that calls place_web_order. Additive only: no
-- existing function or trigger changes, so the code running now keeps working. Safe to rerun.
set lock_timeout = '5s';

-- A personal menu link is signed by the server and needs no row until it is used. One row per
-- used link makes each link place at most one order, even when tapped twice.
create table if not exists public.menu_link_uses (
  company_id text not null,
  nonce text not null,
  conversation_id text not null,
  order_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz not null default now(),
  primary key (company_id, nonce),
  constraint menu_link_uses_nonce_format check (nonce ~ '^[A-Za-z0-9_-]{11}$'),
  constraint menu_link_uses_conversation foreign key (company_id, conversation_id)
    references public.conversations(company_id, id) on delete cascade
);
create index if not exists menu_link_uses_expiry on public.menu_link_uses(expires_at);
create index if not exists menu_link_uses_conversation on public.menu_link_uses(company_id, conversation_id);
alter table public.menu_link_uses enable row level security;
revoke all on public.menu_link_uses from public, anon, authenticated;
grant all on public.menu_link_uses to service_role;

-- Orders started on the public menu page (Instagram, QR). Nothing is ordered or sent until the
-- customer sends the code from their own WhatsApp. The code, phone and the visitor's network
-- address (ip_key, only to cap one source's open drafts) are kept only as keyed hashes. Name,
-- address (in cart) and hashes are wiped when the draft is used or expires; rows go an hour
-- after they expire (purge_menu_ordering, scheduled in 202610190003).
create table if not exists public.menu_drafts (
  id text primary key,
  company_id text not null references public.companies(id) on delete cascade,
  code_hash text not null unique,
  phone_hash text,
  ip_key text,
  cart jsonb,
  quoted_total bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  order_id text,
  conversation_id text,
  constraint menu_drafts_code_hash check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint menu_drafts_phone_hash check (phone_hash is null or phone_hash ~ '^[0-9a-f]{64}$'),
  constraint menu_drafts_ip_key check (ip_key is null or ip_key ~ '^[A-Za-z0-9_-]{22}$'),
  constraint menu_drafts_total check (quoted_total >= 0),
  constraint menu_drafts_expiry check (expires_at > created_at and expires_at <= created_at + interval '1 hour')
);
create index if not exists menu_drafts_open on public.menu_drafts(company_id, expires_at) where used_at is null;
create index if not exists menu_drafts_open_source on public.menu_drafts(company_id, ip_key) where used_at is null;
create index if not exists menu_drafts_expiry on public.menu_drafts(expires_at);
alter table public.menu_drafts enable row level security;
revoke all on public.menu_drafts from public, anon, authenticated;
grant all on public.menu_drafts to service_role;

-- Saves a draft that expires p_minutes from now (database clock). A business never holds more
-- than about p_max_open unconfirmed drafts (a storage backstop), and one network address
-- (ipKey, when known) no more than 15, so no single source can use up a business's drafts. A
-- number keeps one open draft: a new one ends its older ones. It never takes the company row
-- lock that chat turns use (FOR UPDATE); the company foreign key only holds a brief KEY SHARE
-- lock while each insert commits. A code collision is reported so the server retries.
create or replace function public.create_menu_draft(p_draft jsonb, p_minutes integer default 30, p_max_open integer default 2000)
returns jsonb language plpgsql security definer set search_path = public as $$
declare expires timestamptz; ip text := p_draft->>'ipKey';
begin
  if p_minutes is null or p_minutes not between 5 and 60 or p_max_open is null or p_max_open < 1 then
    raise exception 'Invalid menu draft limits';
  end if;
  if coalesce(p_draft->>'id', '') = '' or jsonb_typeof(p_draft->'cart') is distinct from 'object'
    or jsonb_typeof(p_draft->'quotedTotal') is distinct from 'number'
    or coalesce(p_draft->>'codeHash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_draft->>'phoneHash', '') !~ '^[0-9a-f]{64}$'
    or (ip is not null and ip !~ '^[A-Za-z0-9_-]{22}$') then
    raise exception 'Invalid menu draft';
  end if;
  if not exists(select 1 from companies where id = p_draft->>'companyId') then raise exception 'Unknown company'; end if;
  if (select count(*) from menu_drafts where company_id = p_draft->>'companyId' and used_at is null and expires_at > now()) >= p_max_open then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  if ip is not null and (select count(*) from menu_drafts where company_id = p_draft->>'companyId' and ip_key = ip
      and used_at is null and expires_at > now()) >= 15 then
    return jsonb_build_object('ok', false, 'reason', 'busy_source');
  end if;
  expires := now() + make_interval(mins => p_minutes);
  begin
    insert into menu_drafts(id, company_id, code_hash, phone_hash, ip_key, cart, quoted_total, expires_at)
      values (p_draft->>'id', p_draft->>'companyId', p_draft->>'codeHash', p_draft->>'phoneHash', ip,
        p_draft->'cart', (p_draft->>'quotedTotal')::bigint, expires);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'collision');
  end;
  -- The number's older open drafts end now (just after they were made, for the expiry check)
  -- and are wiped as on expiry.
  update menu_drafts set expires_at = greatest(now(), created_at + interval '1 millisecond'),
      cart = null, phone_hash = null, ip_key = null
    where company_id = p_draft->>'companyId' and phone_hash = p_draft->>'phoneHash'
      and used_at is null and expires_at > now() and id <> p_draft->>'id';
  return jsonb_build_object('ok', true, 'expiresAt', to_char(expires at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

-- Places a menu-page order: insert only (never updates an order), and marks the personal link or
-- the draft used in the same transaction. The same submission again returns the order already
-- placed. check_order_snapshot still re-checks prices and refuses orders while the bot is off.
create or replace function public.place_web_order(p_company_id text, p_conversation jsonb, p_expected_version integer,
  p_order jsonb, p_jobs jsonb, p_claim jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j jsonb; existing jsonb; business jsonb; draft public.menu_drafts%rowtype; conv public.conversations%rowtype;
  claim_keys jsonb := coalesce(p_claim->'keys', '[]'::jsonb);
begin
  if p_conversation->>'companyId' is distinct from p_company_id or p_order->>'companyId' is distinct from p_company_id
    or p_order->>'conversationId' is distinct from p_conversation->>'id' then
    raise exception 'Cross-company web order';
  end if;
  if p_conversation->>'channel' is distinct from 'whatsapp' or p_order->>'sandbox' is distinct from 'false'
    or p_order->>'status' is distinct from 'pending' or p_order->>'source' is distinct from 'menu_page'
    or p_conversation->'cart'->>'status' is distinct from 'submitted'
    or p_conversation->'cart'->>'orderId' is distinct from p_order->>'id'
    or jsonb_typeof(claim_keys) is distinct from 'array' then
    raise exception 'Invalid web order';
  end if;
  select data into business from companies where id = p_company_id for update;
  if not found then raise exception 'Unknown company'; end if;
  select data into existing from orders where company_id = p_company_id and submission_key = p_order->>'submissionKey';
  if found then return jsonb_build_object('ok', false, 'reason', 'duplicate', 'order', existing); end if;
  if business->>'botEnabled' is distinct from 'true' then
    return jsonb_build_object('ok', false, 'reason', 'bot_off');
  end if;
  -- block_customer takes the same company lock, so a block cannot slip in between.
  if exists(select 1 from blocked_customers b where b.company_id = p_company_id
      and b.key in (select jsonb_array_elements_text(claim_keys))) then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  if p_claim->>'kind' = 'link' then
    if coalesce(p_claim->>'nonce', '') !~ '^[A-Za-z0-9_-]{11}$' or p_claim->>'expiresAt' is null then
      raise exception 'Invalid menu link claim';
    end if;
    if exists(select 1 from menu_link_uses where company_id = p_company_id and nonce = p_claim->>'nonce') then
      return jsonb_build_object('ok', false, 'reason', 'used');
    end if;
    if (p_claim->>'expiresAt')::timestamptz <= now() then
      return jsonb_build_object('ok', false, 'reason', 'expired');
    end if;
  elsif p_claim->>'kind' = 'draft' then
    select * into draft from menu_drafts where id = p_claim->>'draftId' and company_id = p_company_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if draft.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
    if draft.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  else
    raise exception 'Invalid web order claim';
  end if;
  select * into conv from conversations where id = p_conversation->>'id' and company_id = p_company_id for update;
  if found then
    if conv.version is distinct from p_expected_version then
      return jsonb_build_object('ok', false, 'reason', 'conversation_changed');
    end if;
    if jsonb_typeof(conv.data->'blocked') = 'object' then
      return jsonb_build_object('ok', false, 'reason', 'blocked');
    end if;
    if conv.data->>'mode' is distinct from 'bot' then
      return jsonb_build_object('ok', false, 'reason', 'staff');
    end if;
    -- A tap on the page is not a customer message: WhatsApp's 24-hour window must not move.
    if p_claim->>'kind' = 'link' and p_conversation->>'lastInboundAt' is distinct from conv.data->>'lastInboundAt' then
      raise exception 'A menu link order must not change lastInboundAt';
    end if;
  elsif p_claim->>'kind' = 'link' or p_expected_version is distinct from 0 then
    return jsonb_build_object('ok', false, 'reason', 'conversation_changed');
  end if;
  if not save_conversation(p_conversation, p_expected_version) then
    raise exception 'Conversation changed during web order';
  end if;
  insert into orders(id, company_id, conversation_id, submission_key, data, created_at, updated_at)
    values (p_order->>'id', p_company_id, p_order->>'conversationId', p_order->>'submissionKey', p_order,
      (p_order->>'createdAt')::timestamptz, (p_order->>'updatedAt')::timestamptz);
  if p_claim->>'kind' = 'link' then
    insert into menu_link_uses(company_id, nonce, conversation_id, order_id, expires_at)
      values (p_company_id, p_claim->>'nonce', p_conversation->>'id', p_order->>'id', (p_claim->>'expiresAt')::timestamptz);
  else
    update menu_drafts set used_at = now(), order_id = p_order->>'id', conversation_id = p_conversation->>'id',
      cart = null, phone_hash = null, ip_key = null
      where id = draft.id;
  end if;
  for j in select value from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) loop
    if j->>'companyId' is distinct from p_company_id then raise exception 'Cross-company job'; end if;
    perform insert_job(j);
  end loop;
  return jsonb_build_object('ok', true, 'order', p_order);
end $$;

-- Clears an unused draft's name, address and hashes as soon as it expires, and removes old
-- rows an hour later. Scheduled every 10 minutes by 202610190003_menu_purge_schedule.sql.
create or replace function public.purge_menu_ordering() returns integer
language plpgsql security definer set search_path = public as $$
declare wiped integer; removed integer; uses integer;
begin
  update menu_drafts set cart = null, phone_hash = null, ip_key = null
    where used_at is null and expires_at <= now()
      and (cart is not null or phone_hash is not null or ip_key is not null);
  get diagnostics wiped = row_count;
  delete from menu_drafts where expires_at < now() - interval '1 hour';
  get diagnostics removed = row_count;
  delete from menu_link_uses where expires_at < now() - interval '1 hour';
  get diagnostics uses = row_count;
  return wiped + removed + uses;
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace = 'public'::regnamespace
    and proname = any(array['create_menu_draft', 'place_web_order', 'purge_menu_ordering']) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
