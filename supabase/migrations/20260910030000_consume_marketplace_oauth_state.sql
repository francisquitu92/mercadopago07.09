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