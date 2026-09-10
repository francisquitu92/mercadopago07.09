-- Base de la app con productos, pedidos, pagos y cuentas Mercado Pago preparadas para OAuth.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text not null default '',
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'CLP' check (currency = 'CLP'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'pending_payment', 'approved', 'rejected', 'cancelled')),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  total numeric(12,2) not null default 0 check (total >= 0),
  currency text not null default 'CLP' check (currency = 'CLP'),
  external_reference text unique,
  preference_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  payment_id text unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  payment_method text,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  currency text not null default 'CLP' check (currency = 'CLP'),
  provider text not null default 'mercadopago' check (provider = 'mercadopago'),
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  create type public.mercado_pago_account_status_enum as enum (
    'connected',
    'disconnected',
    'reauthorization_required'
  );
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.mercado_pago_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  mp_user_id text not null unique check (btrim(mp_user_id) <> ''),
  access_token text not null check (btrim(access_token) <> ''),
  refresh_token text check (refresh_token is null or btrim(refresh_token) <> ''),
  expires_at timestamptz not null,
  token_type text not null default 'Bearer' check (btrim(token_type) <> ''),
  scope text,
  status public.mercado_pago_account_status_enum not null default 'connected',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mercado_pago_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null unique check (btrim(state_hash) <> ''),
  code_verifier text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, new.id::text || '@invalid.local'))
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists order_items_order_id_idx on public.order_items(order_id);
create index if not exists payments_order_id_idx on public.payments(order_id);
create index if not exists mercado_pago_accounts_status_idx
  on public.mercado_pago_accounts(status);
create index if not exists mercado_pago_oauth_states_expires_at_idx
  on public.mercado_pago_oauth_states(expires_at);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.mercado_pago_accounts enable row level security;
alter table public.mercado_pago_oauth_states enable row level security;

create policy "Profiles are viewable by owner" on public.profiles
for select using (auth.uid() = id);

create policy "Profiles can be inserted by owner" on public.profiles
for insert with check (auth.uid() = id);

create policy "Profiles can be updated by owner" on public.profiles
for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "Active products are readable by everyone" on public.products
for select using (is_active = true);

create policy "Product writes are blocked for browser clients" on public.products
for all using (false) with check (false);

create policy "Users can create their own draft orders" on public.orders
for insert with check (
  auth.uid() = user_id
  and status in ('draft', 'pending_payment')
);

create policy "Users can view their own orders" on public.orders
for select using (auth.uid() = user_id);

create policy "Users cannot directly update financial order fields" on public.orders
for update using (false) with check (false);

create policy "Users cannot delete orders from browser" on public.orders
for delete using (false);

create policy "Users can view their own order items" on public.order_items
for select using (
  exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and o.user_id = auth.uid()
  )
);

create policy "Order item writes are blocked for browser clients" on public.order_items
for all using (false) with check (false);

create policy "Users can view their own payments" on public.payments
for select using (
  exists (
    select 1 from public.orders o
    where o.id = payments.order_id
      and o.user_id = auth.uid()
  )
);

create policy "Payment writes are blocked for browser clients" on public.payments
for all using (false) with check (false);

create policy "Users can view their Mercado Pago account status"
on public.mercado_pago_accounts
for select
using (auth.uid() = user_id);

revoke all on table public.mercado_pago_accounts from anon, authenticated;

grant select (
  status,
  connected_at,
  disconnected_at
)
on table public.mercado_pago_accounts
to authenticated;

create or replace view public.mercado_pago_account_status
with (security_invoker = true)
as
select
  status,
  connected_at,
  disconnected_at
from public.mercado_pago_accounts
where user_id = auth.uid();

revoke all on table public.mercado_pago_account_status from anon;
grant select on table public.mercado_pago_account_status to authenticated;

revoke all on table public.mercado_pago_oauth_states from anon, authenticated;

create or replace function public.consume_marketplace_oauth_state(p_state_hash text)
returns table (
  user_id uuid,
  code_verifier text,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  update public.mercado_pago_oauth_states
  set consumed_at = now()
  where state_hash = p_state_hash
    and consumed_at is null
    and expires_at > now()
  returning user_id, code_verifier, expires_at;
$$;

revoke all on function public.consume_marketplace_oauth_state(text) from public, anon, authenticated;
grant execute on function public.consume_marketplace_oauth_state(text) to service_role;
