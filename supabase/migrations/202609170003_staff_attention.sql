-- Derived from current state: resolving work clears its alert without a second write.
create index orders_staff_attention on public.orders(company_id,created_at desc,id) where data->>'status'='pending' and data->>'sandbox'='false';
create index conversations_staff_attention on public.conversations(company_id,updated_at desc,id) where channel='whatsapp' and data->>'mode'='human';
create index jobs_staff_attention on public.jobs(company_id,created_at desc,id) where status='failed';
create function public.staff_attention(p_company_id text) returns jsonb
language sql stable security definer set search_path=public as $$
  with alerts as (
    select 'order:'||id as id,'order'::text as kind,id as "entityId",created_at as "createdAt"
      from orders where company_id=p_company_id and data->>'status'='pending' and data->>'sandbox'='false'
    union all
    select 'handoff:'||id,'handoff',id,updated_at from conversations
      where company_id=p_company_id and channel='whatsapp' and data->>'mode'='human'
    union all
    select 'job:'||id,'job',id,created_at from jobs
      where company_id=p_company_id and status='failed'
  )
  select jsonb_build_object('total',(select count(*) from alerts),
    'orders',(select count(*) from alerts where kind='order'),
    'handoffs',(select count(*) from alerts where kind='handoff'),
    'failures',(select count(*) from alerts where kind='job'),
    'items',coalesce((select jsonb_agg(to_jsonb(a)) from (select * from alerts order by "createdAt" desc,id limit 30) a),'[]'::jsonb));
$$;
revoke all on function public.staff_attention(text) from public,anon,authenticated;
grant execute on function public.staff_attention(text) to service_role;
