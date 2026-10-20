-- Deals: combos and time-limited offers. They live in their own table, so a CSV import or a
-- Sheets refresh (replace_products) never touches them, and an owner edits them in Orderly
-- whatever the menu source. When the bot or the menu page sells, the backend turns each deal
-- into a menu entry for that moment (src/shared/deals.ts); a deal's order line is the deal's
-- price plus the extra charge of each pick, with its picks as {group, option} in group order
-- (and as the variant label "Drink: Sprite, Side: Fries") and what it includes. Menu items and
-- deals share one id space: a deal's id is public on the menu page, so no business may give a
-- menu item a deal's id, or a deal a menu item's. Deal times are checked by the backend only, as
-- opening hours are: a database refusal would come at commit time, not when the message came.
-- Apply after 202610200003_order_flow.sql and before deploying the backend that reads deals.
-- The backend and dashboard running now keep working: they never read the new table, product
-- lines are checked exactly as before (validate_order_snapshot keeps its product checks word
-- for word), enforce_json_references is unchanged and no function changes its signature.
-- Safe to rerun while no later file redefines validate_order_snapshot.
set lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.order_status_counts(text,boolean)') is null then
    raise exception 'Apply 202610200003_order_flow.sql before 202610210001_deals.sql';
  end if;
end $$;

-- Only the backend reads or writes deals (service role); the dashboard gets them from it.
create table if not exists public.deals (
  id text primary key, company_id text not null references public.companies(id) on delete cascade,
  data jsonb not null, unique (company_id, id),
  check (data->>'id' is not distinct from id), check (data->>'companyId' is not distinct from company_id)
);
alter table public.deals enable row level security;
revoke all on public.deals from public, anon, authenticated;
grant all on public.deals to service_role;
drop trigger if exists immutable_company on public.deals;
create trigger immutable_company before update on public.deals
  for each row execute function public.enforce_company_ownership();

-- One id space. The order check finds a line's menu item first, then its deal, so a shared id
-- would price the wrong thing; and as replace_products refuses another business's menu item id,
-- an import can never take another business's deal id either.
create or replace function public.enforce_catalog_id() returns trigger language plpgsql set search_path=public as $$
begin
  if (tg_table_name='products' and exists(select 1 from deals where id=new.id))
    or (tg_table_name='deals' and exists(select 1 from products where id=new.id)) then
    raise exception 'Menu item ID is already in use';
  end if;
  return new;
end $$;
drop trigger if exists catalog_id_unique on public.products;
create trigger catalog_id_unique before insert or update of id on public.products
  for each row execute function public.enforce_catalog_id();
drop trigger if exists catalog_id_unique on public.deals;
create trigger catalog_id_unique before insert or update of id on public.deals
  for each row execute function public.enforce_catalog_id();
revoke all on function public.enforce_catalog_id() from public, anon, authenticated;
grant execute on function public.enforce_catalog_id() to service_role;

-- Latest body from 202609160001_launch_hardening.sql; a line for a menu item is checked word for
-- word as there. Changed: a line whose id is no menu item of the business is looked up as one of
-- its deals. The deal must be on (available) with a numeric price. The line has no extras, its
-- choices name, in order, every choice group of the deal and an option of that group with a
-- numeric price (matched by the group's position, so two groups may share an option name), and
-- its variant is those picks as "Group: Option, ..." (none when the deal has no choices). Its
-- unit price is the deal's price plus each pick's extra charge; quantity and totals are checked
-- as for a menu item.
create or replace function public.validate_order_snapshot() returns trigger language plpgsql set search_path=public as $$
declare line jsonb; product jsonb; business jsonb; opt jsonb; unit numeric; subtotal numeric:=0; fee numeric:=0; quantity integer; option_name text; deal jsonb; picks jsonb; label text;
begin
  select data into business from companies where id=new.company_id for share;
  if business->>'botEnabled' is distinct from 'true' and not exists(select 1 from conversations where id=new.conversation_id and company_id=new.company_id and channel='demo') then raise exception 'Automatic ordering is paused'; end if;
  if new.data->>'status'!='pending' then raise exception 'New orders must await staff acceptance'; end if;
  if jsonb_array_length(new.data->'items')=0 then raise exception 'Empty order'; end if;
  for line in select value from jsonb_array_elements(new.data->'items') loop
    select data into product from products where id=line->>'productId' and company_id=new.company_id for share;
    if product is null then
      select data into deal from deals where id=line->>'productId' and company_id=new.company_id for share;
      if deal is null or deal->'available' is distinct from 'true'::jsonb or jsonb_typeof(deal->'price') is distinct from 'number' then raise exception 'Catalog changed: item unavailable'; end if;
      if jsonb_array_length(coalesce(line->'modifiers','[]'))>0 then raise exception 'Catalog changed: invalid deal line'; end if;
      quantity:=(line->>'quantity')::integer;
      if quantity<1 or quantity>50 then raise exception 'Invalid quantity'; end if;
      unit:=(deal->>'price')::numeric;
      picks:=coalesce(line->'choices','[]');
      if jsonb_typeof(picks) is distinct from 'array' or jsonb_array_length(picks)!=jsonb_array_length(coalesce(deal->'choices','[]')) then raise exception 'Catalog changed: invalid deal choice'; end if;
      label:=null;
      for i in 0..jsonb_array_length(picks)-1 loop
        select value into opt from jsonb_array_elements(deal->'choices'->i->'options') where value->>'name'=picks->i->>'option' and jsonb_typeof(value->'price')='number';
        if opt is null or picks->i->>'group' is distinct from deal->'choices'->i->>'name' then raise exception 'Catalog changed: invalid deal choice'; end if;
        unit:=unit+(opt->>'price')::numeric;
        label:=concat_ws(', ',label,(picks->i->>'group')||': '||(picks->i->>'option'));
      end loop;
      if line->>'variant' is distinct from label then raise exception 'Catalog changed: invalid deal line'; end if;
    else
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
    end if;
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

insert into public.orderly_schema_migrations(name) values ('202610210001_deals.sql')
  on conflict (name) do nothing;
notify pgrst, 'reload schema';
