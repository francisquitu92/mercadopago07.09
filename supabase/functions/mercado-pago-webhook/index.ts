const getEnv = (name: string): string | undefined => {
  if (typeof Deno !== 'undefined') {
    return Deno.env.get(name) ?? undefined
  }

  const maybeProcess = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }).process

  return maybeProcess?.env?.[name]
}

const safeJson = async (req: Request): Promise<Record<string, unknown> | null> => {
  const text = await req.text()
  if (!text.trim()) {
    return null
  }

  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

const parseSignatureHeader = (header: string): { ts: string | null; versions: Map<string, string> } => {
  const versions = new Map<string, string>()

  for (const chunk of header.split(',')) {
    const trimmed = chunk.trim()
    if (!trimmed || !trimmed.includes('=')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase()
    const value = trimmed.slice(separatorIndex + 1).trim()

    if (!key || !value) {
      continue
    }

    if (key === 'ts') {
      versions.set('ts', value)
      continue
    }

    if (/^v\d+$/.test(key)) {
      versions.set(key, value)
    }
  }

  return { ts: versions.get('ts') ?? null, versions }
}

const buildManifest = (dataId: string | null, requestId: string | null, ts: string): string => {
  const parts: string[] = []

  if (dataId) {
    parts.push(`id:${dataId}`)
  }

  if (requestId) {
    parts.push(`request-id:${requestId}`)
  }

  parts.push(`ts:${ts}`)

  return `${parts.join(';')};`
}

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const computeHmacSha256 = async (secret: string, manifest: string): Promise<string> => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(manifest))
  return toHex(signature)
}

const timingSafeEqual = (left: string, right: string): boolean => {
  const maxLength = Math.max(left.length, right.length)
  let diff = 0

  for (let index = 0; index < maxLength; index += 1) {
    const leftChar = left.charCodeAt(index % left.length)
    const rightChar = right.charCodeAt(index % right.length)
    diff |= leftChar ^ rightChar
  }

  return diff === 0 && left.length === right.length
}

const normalizePaymentStatus = (status: string | null | undefined): string => {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled'
    case 'pending':
    case 'in_process':
    case 'in_mediation':
      return 'pending'
    default:
      return 'pending'
  }
}

const mapOrderStatus = (paymentStatus: string): string => {
  switch (paymentStatus) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled'
    case 'pending':
    default:
      return 'pending_payment'
  }
}

const parseNumeric = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export default async function handler(req: Request): Promise<Response> {
  const method = req.method.toUpperCase()

  if (method !== 'POST') {
    return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 })
  }

  const signatureHeader = req.headers.get('x-signature')?.trim() ?? ''
  const requestId = req.headers.get('x-request-id')?.trim() ?? ''
  const url = new URL(req.url)

  if (!signatureHeader) {
    return Response.json({ ok: false, error: 'Missing x-signature header' }, { status: 401 })
  }

  if (!requestId) {
    return Response.json({ ok: false, error: 'Missing x-request-id header' }, { status: 401 })
  }

  const secret = getEnv('MP_WEBHOOK_SECRET')
  if (!secret) {
    return Response.json({ ok: false, error: 'MP_WEBHOOK_SECRET is not configured' }, { status: 500 })
  }

  const parsedSignature = parseSignatureHeader(signatureHeader)
  const ts = parsedSignature.ts
  const versions = parsedSignature.versions

  if (!ts || !ts.match(/^\d+$/)) {
    return Response.json({ ok: false, error: 'Malformed x-signature header' }, { status: 401 })
  }

  const versionPriority = ['v1', 'v2']
  const receivedHash = versionPriority.find((version) => versions.has(version))
    ? versions.get(versionPriority.find((version) => versions.has(version)) ?? '') ?? null
    : null

  if (!receivedHash) {
    return Response.json({ ok: false, error: 'Missing supported signature hash' }, { status: 401 })
  }

  const nowMs = Date.now()
  const tsMs = Number(ts) * 1000
  if (Math.abs(nowMs - tsMs) > 5 * 60 * 1000) {
    return Response.json({ ok: false, error: 'Webhook timestamp is outside tolerance window' }, { status: 401 })
  }

  const payload = (await safeJson(req)) ?? {}
  const payloadType = typeof payload.type === 'string' ? payload.type.toLowerCase() : ''
  const payloadAction = typeof payload.action === 'string' ? payload.action.toLowerCase() : ''

  if (payloadType && payloadType !== 'payment') {
    return Response.json({ ok: true, ignored: true, type: payloadType, action: payloadAction }, { status: 200 })
  }

  const dataIdFromPayload =
    typeof (payload as Record<string, unknown>).data === 'object' && (payload as Record<string, unknown>).data !== null
      ? (payload as Record<string, unknown>).data && typeof ((payload as Record<string, unknown>).data as Record<string, unknown>).id !== 'undefined'
        ? String(((payload as Record<string, unknown>).data as Record<string, unknown>).id)
        : null
      : null

  const dataIdFromQuery = url.searchParams.get('data.id') ?? url.searchParams.get('data_id') ?? url.searchParams.get('id')
  const dataId = dataIdFromQuery ?? dataIdFromPayload ?? ''

  if (!dataId) {
    return Response.json({ ok: false, error: 'Missing payment identifier' }, { status: 400 })
  }

  if (dataIdFromQuery && dataIdFromPayload && dataIdFromQuery !== dataIdFromPayload) {
    return Response.json({ ok: false, error: 'Payment identifiers do not match' }, { status: 400 })
  }

  const manifest = buildManifest(dataId, requestId || null, ts)
  const computedHash = await computeHmacSha256(secret, manifest)

  if (!timingSafeEqual(computedHash, receivedHash)) {
    return Response.json({ ok: false, error: 'Invalid webhook signature' }, { status: 401 })
  }

  const mpAccessToken = getEnv('MP_ACCESS_TOKEN')
  if (!mpAccessToken) {
    return Response.json({ ok: false, error: 'MP_ACCESS_TOKEN is not configured' }, { status: 500 })
  }

  let paymentResponse: Response

  try {
    paymentResponse = await fetchWithTimeout(
      `https://api.mercadopago.com/v1/payments/${dataId}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${mpAccessToken}`,
        },
      },
      10_000,
    )
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'Mercado Pago request timed out'
      : 'Mercado Pago request failed'

    return Response.json({ ok: false, error: message }, { status: 502 })
  }

  if (!paymentResponse.ok) {
    const detail = await paymentResponse.text().catch(() => '')

    if (paymentResponse.status === 404) {
      return Response.json(
        { ok: true, processed: false, ignored: true, reason: 'Payment does not exist in Mercado Pago' },
        { status: 200 },
      )
    }

    return Response.json(
      { ok: false, error: 'Failed to fetch payment details', status: paymentResponse.status, detail },
      { status: 502 },
    )
  }

  const payment = (await paymentResponse.json()) as Record<string, unknown>
  const paymentStatus = normalizePaymentStatus(typeof payment.status === 'string' ? payment.status : null)
  const normalizedOrderStatus = mapOrderStatus(paymentStatus)

  const supabaseUrl = getEnv('SUPABASE_URL')
  const supabaseServiceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return Response.json({ ok: false, error: 'Supabase credentials are not configured' }, { status: 500 })
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.53.0')
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  const externalReference =
    typeof payment.external_reference === 'string' && payment.external_reference.trim() !== ''
      ? payment.external_reference
      : null

  if (!externalReference) {
    return Response.json({ ok: true, ignored: true, reason: 'No external_reference found' }, { status: 200 })
  }

  const { data: existingPayment, error: existingPaymentError } = await supabase
    .from('payments')
    .select('payment_id, status')
    .eq('payment_id', String(payment.id ?? dataId))
    .maybeSingle()

  if (existingPaymentError) {
    return Response.json({ ok: false, error: existingPaymentError.message }, { status: 500 })
  }

  if (existingPayment && existingPayment.status === paymentStatus) {
    return Response.json({ ok: true, processed: false, reason: 'Duplicate payment webhook', payment_id: String(payment.id ?? dataId) }, { status: 200 })
  }

  const { data: order, error: orderSelectError } = await supabase
    .from('orders')
    .select('*')
    .eq('external_reference', externalReference)
    .maybeSingle()

  if (orderSelectError) {
    return Response.json({ ok: false, error: orderSelectError.message }, { status: 500 })
  }

  if (!order) {
    return Response.json({ ok: true, ignored: true, reason: 'No matching order found', external_reference: externalReference }, { status: 200 })
  }

  const paymentAmount = parseNumeric(payment.transaction_amount ?? payment.amount)
  const paymentCurrency = typeof payment.currency === 'string' ? payment.currency : 'CLP'

  const expectedAmount = parseNumeric((order as Record<string, unknown>).total)
  const expectedCurrency = typeof (order as Record<string, unknown>).currency === 'string'
    ? (order as Record<string, unknown>).currency
    : 'CLP'

  if (expectedAmount > 0 && paymentAmount !== expectedAmount) {
    return Response.json(
      {
        ok: true,
        ignored: true,
        reason: 'Payment amount does not match the order total',
        expected: expectedAmount,
        received: paymentAmount,
      },
      { status: 200 },
    )
  }

  if (paymentCurrency !== expectedCurrency) {
    return Response.json(
      {
        ok: true,
        ignored: true,
        reason: 'Payment currency does not match the order currency',
        expected: expectedCurrency,
        received: paymentCurrency,
      },
      { status: 200 },
    )
  }

  const paymentRecord = {
    order_id: (order as Record<string, unknown>).id,
    payment_id: String(payment.id ?? dataId),
    status: paymentStatus,
    payment_method: typeof payment.payment_method === 'object' && payment.payment_method !== null
      ? ((payment.payment_method as Record<string, unknown>).id as string | null) ?? ((payment.payment_method as Record<string, unknown>).type as string | null) ?? null
      : null,
    amount: paymentAmount || expectedAmount,
    currency: paymentCurrency,
    provider: 'mercadopago',
    raw_payload: payment,
    updated_at: new Date().toISOString(),
  }

  const { error: paymentUpsertError } = await supabase
    .from('payments')
    .upsert(paymentRecord, { onConflict: 'payment_id' })

  if (paymentUpsertError) {
    return Response.json({ ok: false, error: paymentUpsertError.message }, { status: 500 })
  }

  const { error: orderUpdateError } = await supabase
    .from('orders')
    .update({
      status: normalizedOrderStatus,
      total: expectedAmount || paymentAmount,
      currency: expectedCurrency,
      updated_at: new Date().toISOString(),
      paid_at: paymentStatus === 'approved' ? new Date().toISOString() : (order as Record<string, unknown>).paid_at ?? null,
    })
    .eq('id', (order as Record<string, unknown>).id)

  if (orderUpdateError) {
    return Response.json({ ok: false, error: orderUpdateError.message }, { status: 500 })
  }

  return Response.json(
    {
      ok: true,
      processed: true,
      payment_id: String(payment.id ?? dataId),
      payment_status: paymentStatus,
      order_status: normalizedOrderStatus,
      external_reference: externalReference,
    },
    { status: 200 },
  )
}
