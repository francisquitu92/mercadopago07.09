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

create index if not exists mercado_pago_accounts_status_idx
  on public.mercado_pago_accounts(status);

alter table public.mercado_pago_accounts enable row level security;

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