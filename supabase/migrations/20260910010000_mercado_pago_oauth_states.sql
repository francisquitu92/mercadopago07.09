create table if not exists public.mercado_pago_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null unique check (btrim(state_hash) <> ''),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mercado_pago_oauth_states_expires_at_idx
  on public.mercado_pago_oauth_states(expires_at);

alter table public.mercado_pago_oauth_states enable row level security;

revoke all on table public.mercado_pago_oauth_states from anon, authenticated;