-- Status changes and their delivery jobs commit together; concurrent accept/cancel cannot both win.
create function public.update_order_status(p_company_id text,p_id text,p_expected_status text,p_new_status text,p_now timestamptz,p_jobs jsonb default '[]',p_conversation jsonb default null,p_expected_version integer default null) returns jsonb
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
    perform 1 from companies where id=p_company_id and data->>'botEnabled'='true' for update;
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

create function public.set_order_sync_status(p_company_id text,p_id text,p_status text,p_expected_updated_at timestamptz default null) returns void
language plpgsql security definer set search_path=public as $$
begin
  if p_status not in ('not_connected','pending','synced','failed') then raise exception 'Invalid sync status'; end if;
  update orders set data=data||jsonb_build_object('syncStatus',p_status)
    where id=p_id and company_id=p_company_id and (p_expected_updated_at is null or updated_at=p_expected_updated_at);
end $$;
create function public.retry_failed_jobs(p_company_id text) returns integer
language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
  update jobs set status='pending',attempts=0,lease_until=null,next_run_at=now(),data=(data-'leaseUntil')||jsonb_build_object('status','pending','attempts',0,'nextRunAt',now())
    where company_id=p_company_id and status='failed';
  get diagnostics affected=row_count;return affected;
end $$;
revoke all on function public.update_order_status(text,text,text,text,timestamptz,jsonb,jsonb,integer),public.set_order_sync_status(text,text,text,timestamptz),public.retry_failed_jobs(text) from public,anon,authenticated;
grant execute on function public.update_order_status(text,text,text,text,timestamptz,jsonb,jsonb,integer),public.set_order_sync_status(text,text,text,timestamptz),public.retry_failed_jobs(text) to service_role;

-- Validate order money against current locked catalog rows at insertion, after engine review.
create function public.validate_order_snapshot() returns trigger language plpgsql set search_path=public as $$
declare line jsonb; product jsonb; business jsonb; opt jsonb; unit numeric; subtotal numeric:=0; fee numeric:=0; quantity integer; option_name text;
begin
  select data into business from companies where id=new.company_id for share;
  if business->>'botEnabled' is distinct from 'true' then raise exception 'Automatic ordering is paused'; end if;
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
create trigger check_order_snapshot before insert on public.orders for each row execute function public.validate_order_snapshot();
revoke all on function public.validate_order_snapshot() from public,anon,authenticated;
grant execute on function public.validate_order_snapshot() to service_role;
