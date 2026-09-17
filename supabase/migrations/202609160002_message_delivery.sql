create table public.message_deliveries (
  company_id text not null references public.companies(id) on delete cascade,
  external_id text not null, conversation_id text, message_id text,
  status text not null check(status in ('accepted','sent','failed','delivered','read')),error text,
  primary key(company_id,external_id),
  foreign key(company_id,conversation_id) references public.conversations(company_id,id) on delete cascade
);
create index message_deliveries_conversation on public.message_deliveries(company_id,conversation_id,message_id);
alter table public.message_deliveries enable row level security;
revoke all on public.message_deliveries from public,anon,authenticated;
grant all on public.message_deliveries to service_role;
create function public.record_delivery(p_company_id text,p_external_id text,p_status text,p_conversation_id text default null,p_message_id text default null,p_error text default null) returns void language sql security definer set search_path=public as $$
  insert into message_deliveries values(p_company_id,p_external_id,p_conversation_id,p_message_id,p_status,p_error)
  on conflict(company_id,external_id) do update set
    conversation_id=coalesce(excluded.conversation_id,message_deliveries.conversation_id),message_id=coalesce(excluded.message_id,message_deliveries.message_id),
    status=case when array_position(array['accepted','sent','failed','delivered','read'],message_deliveries.status)>array_position(array['accepted','sent','failed','delivered','read'],excluded.status) then message_deliveries.status else excluded.status end,
    error=coalesce(excluded.error,message_deliveries.error);
$$;
revoke all on function public.record_delivery(text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_delivery(text,text,text,text,text,text) to service_role;
