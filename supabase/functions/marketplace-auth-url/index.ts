import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.53.0'

const mercadopagoAuthorizationEndpoint = 'https://auth.mercadopago.com/authorization'
const stateLifetimeMs = 10 * 60 * 1000

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

const createState = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

const createCodeVerifier = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

const hashBase64Url = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toBase64Url(new Uint8Array(digest))
}

const getBearerToken = (request: Request): string | null => {
  const authorization = request.headers.get('authorization') ?? ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

const getCorsHeaders = (request: Request): Record<string, string> => {
  const appBaseUrl = getEnv('APP_BASE_URL')
  const requestOrigin = request.headers.get('origin') ?? ''
  const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
  ])

  if (appBaseUrl) {
    try {
      allowedOrigins.add(new URL(appBaseUrl).origin)
    } catch {
      console.log('stage=cors_config_validation_failed')
    }
  }

  const origin = allowedOrigins.has(requestOrigin) ? requestOrigin : ''

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

const jsonResponse = (body: Record<string, unknown>, status: number, corsHeaders: Record<string, string>): Response =>
  Response.json(body, { status, headers: corsHeaders })

Deno.serve(async (request) => {
  const corsHeaders = getCorsHeaders(request)

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, corsHeaders)
  }

  const supabaseUrl = getEnv('SUPABASE_URL')
  const supabaseAnonKey = getEnv('SUPABASE_ANON_KEY')
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
  const clientId = getEnv('MP_CLIENT_ID')
  const redirectUri = getEnv('MP_OAUTH_REDIRECT_URI')
  const bearerToken = getBearerToken(request)

  if (!bearerToken) {
    return jsonResponse({ ok: false, error: 'Authentication required' }, 401, corsHeaders)
  }

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    console.log('stage=supabase_config_validation_failed')
    return jsonResponse({ ok: false, error: 'Marketplace OAuth is not configured' }, 500, corsHeaders)
  }

  let redirectUrl: URL
  try {
    redirectUrl = new URL(redirectUri)
  } catch {
    console.log('stage=redirect_uri_validation_failed')
    return jsonResponse({ ok: false, error: 'Marketplace OAuth is not configured' }, 500, corsHeaders)
  }

  if (redirectUrl.protocol !== 'https:') {
    console.log('stage=redirect_uri_protocol_validation_failed')
    return jsonResponse({ ok: false, error: 'Marketplace OAuth is not configured' }, 500, corsHeaders)
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await authClient.auth.getUser()

  if (userError || !userData.user) {
    console.log('stage=authentication_validation_failed')
    return jsonResponse({ ok: false, error: 'Authentication required' }, 401, corsHeaders)
  }

  if (!clientId || !redirectUri) {
    console.log('stage=oauth_config_validation_failed')
    return jsonResponse({ ok: false, error: 'Marketplace OAuth is not configured' }, 500, corsHeaders)
  }

  let state: string
  let stateHash: string
  let codeVerifier: string
  let codeChallenge: string
  try {
    state = createState()
    stateHash = await hashBase64Url(state)
    codeVerifier = createCodeVerifier()
    codeChallenge = await hashBase64Url(codeVerifier)
  } catch {
    console.log('stage=state_generation_failed')
    return jsonResponse({ ok: false, error: 'Unable to start OAuth authorization' }, 500, corsHeaders)
  }

  const serverClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const expiresAt = new Date(Date.now() + stateLifetimeMs).toISOString()
  const { error: insertError } = await serverClient
    .from('mercado_pago_oauth_states')
    .insert({
      user_id: userData.user.id,
      state_hash: stateHash,
      code_verifier: codeVerifier,
      expires_at: expiresAt,
    })

  if (insertError) {
    console.log('stage=state_persistence_failed')
    return jsonResponse({ ok: false, error: 'Unable to start OAuth authorization' }, 500, corsHeaders)
  }

  try {
    const authorizationUrl = new URL(mercadopagoAuthorizationEndpoint)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', clientId)
    authorizationUrl.searchParams.set('platform_id', 'mp')
    authorizationUrl.searchParams.set('redirect_uri', redirectUrl.toString())
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')

    return jsonResponse({ authorization_url: authorizationUrl.toString() }, 200, corsHeaders)
  } catch {
    console.log('stage=authorization_url_build_failed')
    return jsonResponse({ ok: false, error: 'Unable to start OAuth authorization' }, 500, corsHeaders)
  }
})