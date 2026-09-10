import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.53.0'

const mercadopagoTokenEndpoint = 'https://api.mercadopago.com/oauth/token'

type ConsumedState = {
  user_id: string
  code_verifier: string
  expires_at: string
}

type OAuthTokenResponse = {
  access_token?: unknown
  refresh_token?: unknown
  user_id?: unknown
  token_type?: unknown
  expires_in?: unknown
  scope?: unknown
}

const getEnv = (name: string): string | undefined => Deno.env.get(name) ?? undefined

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const hashState = async (state: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))
  return toBase64Url(new Uint8Array(digest))
}

const getFrontendRedirect = (status: 'connected' | 'error'): Response | null => {
  const appBaseUrl = getEnv('APP_BASE_URL')
  if (!appBaseUrl) {
    return null
  }

  try {
    const redirectUrl = new URL(appBaseUrl)
    redirectUrl.searchParams.set('marketplace', status)
    return Response.redirect(redirectUrl.toString(), 303)
  } catch {
    return null
  }
}

const errorResponse = (reason: string, status = 500): Response => {
  const redirect = getFrontendRedirect('error')
  if (redirect) {
    console.log(`stage=callback_error reason=${reason}`)
    return redirect
  }

  return Response.json({ ok: false, error: 'Marketplace OAuth callback failed' }, { status })
}

const successResponse = (): Response => {
  const redirect = getFrontendRedirect('connected')
  if (redirect) {
    return redirect
  }

  return Response.json({ ok: true, connected: true })
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') {
    return errorResponse('method_not_allowed', 405)
  }

  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const state = requestUrl.searchParams.get('state')
  const providerError = requestUrl.searchParams.get('error')

  if (providerError) {
    return errorResponse('authorization_denied', 400)
  }

  if (!code || !state) {
    return errorResponse('missing_callback_parameters', 400)
  }

  const supabaseUrl = getEnv('SUPABASE_URL')
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
  const clientId = getEnv('MP_CLIENT_ID')
  const clientSecret = getEnv('MP_CLIENT_SECRET')
  const redirectUri = getEnv('MP_OAUTH_REDIRECT_URI')

  if (!supabaseUrl || !serviceRoleKey || !clientId || !clientSecret || !redirectUri) {
    return errorResponse('configuration_missing')
  }

  let stateHash: string
  try {
    stateHash = await hashState(state)
  } catch {
    return errorResponse('state_hash_failed')
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: consumedStateRows, error: consumeError } = await supabase
    .rpc('consume_marketplace_oauth_state', { p_state_hash: stateHash })

  if (consumeError || !Array.isArray(consumedStateRows) || consumedStateRows.length !== 1) {
    return errorResponse('invalid_or_expired_state', 400)
  }

  const consumedState = consumedStateRows[0] as ConsumedState
  if (!consumedState.user_id || !consumedState.code_verifier) {
    return errorResponse('invalid_state_record')
  }

  let tokenResponse: Response
  try {
    tokenResponse = await fetch(mercadopagoTokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_secret: clientSecret,
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: consumedState.code_verifier,
      }),
    })
  } catch {
    return errorResponse('token_exchange_failed')
  }

  let credentials: OAuthTokenResponse
  try {
    credentials = await tokenResponse.json() as OAuthTokenResponse
  } catch {
    return errorResponse('token_response_invalid')
  }

  if (!tokenResponse.ok) {
    return errorResponse('token_exchange_rejected', tokenResponse.status >= 500 ? 502 : 400)
  }

  const accessToken = typeof credentials.access_token === 'string' ? credentials.access_token : null
  const refreshToken = typeof credentials.refresh_token === 'string' ? credentials.refresh_token : null
  const mpUserId = credentials.user_id === undefined || credentials.user_id === null
    ? null
    : String(credentials.user_id)
  const tokenType = typeof credentials.token_type === 'string' ? credentials.token_type : null
  const expiresIn = typeof credentials.expires_in === 'number' ? credentials.expires_in : Number(credentials.expires_in)
  const scope = typeof credentials.scope === 'string' ? credentials.scope : null

  if (!accessToken || !mpUserId || !tokenType || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return errorResponse('token_response_invalid')
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
  const { error: accountError } = await supabase
    .from('mercado_pago_accounts')
    .upsert({
      user_id: consumedState.user_id,
      mp_user_id: mpUserId,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      token_type: tokenType,
      scope,
      status: 'connected',
      connected_at: new Date().toISOString(),
      disconnected_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (accountError) {
    return errorResponse('account_persistence_failed')
  }

  return successResponse()
})