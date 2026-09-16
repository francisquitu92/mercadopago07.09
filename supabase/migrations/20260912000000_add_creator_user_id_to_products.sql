alter table public.products
  add column creator_user_id uuid;

alter table public.products
  add constraint products_creator_user_id_fkey
  foreign key (creator_user_id)
  references auth.users(id)
  on delete restrict;

create index products_creator_user_id_idx
  on public.products(creator_user_id);

do $$
declare
  connected_seller_count bigint;
  connected_user_id uuid;
  products_without_creator bigint;
begin
  select count(*)
  into connected_seller_count
  from public.mercado_pago_accounts
  where status = 'connected'
    and expires_at > now()
    and btrim(mp_user_id) <> '';

  if connected_seller_count <> 1 then
    raise exception 'Expected exactly one connected, unexpired Mercado Pago seller; found %', connected_seller_count;
  end if;

  select user_id
  into connected_user_id
  from public.mercado_pago_accounts
  where status = 'connected'
    and expires_at > now()
    and btrim(mp_user_id) <> ''
  order by user_id
  limit 1;

  update public.products
  set creator_user_id = connected_user_id
  where creator_user_id is null;

  select count(*)
  into products_without_creator
  from public.products
  where creator_user_id is null;

  if products_without_creator <> 0 then
    raise exception 'Product backfill left % products without a creator', products_without_creator;
  end if;

  alter table public.products
    alter column creator_user_id set not null;
end;
$$;