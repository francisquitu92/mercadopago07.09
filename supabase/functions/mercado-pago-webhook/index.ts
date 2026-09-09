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
  if (left.length !== right.length) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }

  return difference === 0
}

const getEnv = (name: string): string | undefined =>
  typeof Deno !== 'undefined' ? Deno.env.get(name) ?? undefined : undefined

const getSecretAvailability = () => ({
  MP_WEBHOOK_SECRET: Boolean(getEnv('MP_WEBHOOK_SECRET')),
  MP_ACCESS_TOKEN: Boolean(getEnv('MP_ACCESS_TOKEN')),
  SUPABASE_URL: Boolean(getEnv('SUPABASE_URL')),
  SUPABASE_SERVICE_ROLE_KEY: Boolean(getEnv('SUPABASE_SERVICE_ROLE_KEY')),
})

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const normalizePaymentStatus = (status: string): 'pending' | 'approved' | 'rejected' | 'cancelled' => {
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
    default:
      return 'pending'
  }
}

const mapOrderStatus = (status: string): 'pending_payment' | 'approved' | 'rejected' | 'cancelled' => {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'pending_payment'
  }
}

const toNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

Deno.serve(async (req) => {
  const method = req.method.toUpperCase()
  const contentType = req.headers.get('content-type')
  const signatureHeader = req.headers.get('x-signature')
  const requestId = req.headers.get('x-request-id')
  const url = new URL(req.url)
  const queryDataId = url.searchParams.get('data.id')

  console.log(`method=${method}`)
  console.log(`has_content_type=${Boolean(contentType)}`)

  if (req.method === 'GET') {
    return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 })
  }

  if (req.method === 'POST') {
    console.log(`has_x_signature=${Boolean(signatureHeader)}`)
    console.log(`has_x_request_id=${Boolean(requestId)}`)
    console.log(`has_query_data_id=${Boolean(queryDataId)}`)

    if (!signatureHeader || !requestId) {
      console.log('signature_valid=false')
      return Response.json({ ok: false, error: 'Missing signature headers' }, { status: 401 })
    }

    const body = await req.text()
    console.log(`body_length=${body.length}`)

    let payload: Record<string, unknown>

    try {
      payload = JSON.parse(body) as Record<string, unknown>
    } catch {
      console.log('json_parsed=false')
      return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
    }

    const data = payload.data
    const dataRecord = typeof data === 'object' && data !== null
      ? data as Record<string, unknown>
      : null
    const bodyDataId = typeof dataRecord?.id === 'string' && dataRecord.id.trim() !== ''
      ? dataRecord.id
      : null
    const resolvedDataId = queryDataId ?? bodyDataId
    const idsMatch = !queryDataId || !bodyDataId || queryDataId === bodyDataId

    console.log('json_parsed=true')
    console.log(`type=${typeof payload.type === 'string' ? payload.type : 'missing'}`)
    console.log(`has_body_data_id=${Boolean(bodyDataId)}`)

    if (!idsMatch) {
      console.log('data_id_consistency=mismatch')
      return Response.json({ ok: false, error: 'Query and body data.id do not match' }, { status: 400 })
    }

    if (!resolvedDataId) {
      console.log('data_id_consistency=missing')
      return Response.json({ ok: false, error: 'Missing data.id' }, { status: 400 })
    }

    console.log('data_id_consistency=ok')
    const signatureParts = new Map<string, string>()
    for (const part of signatureHeader.split(',')) {
      const separatorIndex = part.indexOf('=')
      if (separatorIndex > 0) {
        const key = part.slice(0, separatorIndex).trim()
        const value = part.slice(separatorIndex + 1).trim()
        if (key && value) {
          signatureParts.set(key, value)
        }
      }
    }

    const timestamp = signatureParts.get('ts')
    const receivedSignature = signatureParts.get('v1')
    console.log(`timestamp_present=${Boolean(timestamp)}`)
    console.log(`signature_version_present=${Boolean(receivedSignature)}`)
    console.log(`payment_id_present=${Boolean(resolvedDataId)}`)

    if (!timestamp || !/^\d+$/.test(timestamp) || !receivedSignature || !/^[0-9a-fA-F]+$/.test(receivedSignature)) {
      console.log('signature_valid=false')
      return Response.json({ ok: false, error: 'Malformed x-signature header' }, { status: 401 })
    }

    const secret = getEnv('MP_WEBHOOK_SECRET')
    const secretAvailability = getSecretAvailability()
    console.log(`MP_WEBHOOK_SECRET_PRESENT=${secretAvailability.MP_WEBHOOK_SECRET}`)
    console.log(`MP_ACCESS_TOKEN_PRESENT=${secretAvailability.MP_ACCESS_TOKEN}`)
    console.log(`SUPABASE_URL_PRESENT=${secretAvailability.SUPABASE_URL}`)
    console.log(`SUPABASE_SERVICE_ROLE_KEY_PRESENT=${secretAvailability.SUPABASE_SERVICE_ROLE_KEY}`)
    const missingSecret = Object.entries(secretAvailability).find(([, present]) => !present)?.[0]
    if (!secret || missingSecret) {
      console.log(`missing_secret=${missingSecret ?? 'MP_WEBHOOK_SECRET'}`)
      console.log('signature_valid=false')
      return Response.json({ ok: false, error: 'Required server secret is not configured' }, { status: 500 })
    }

    const manifest = `id:${resolvedDataId};request-id:${requestId};ts:${timestamp};`
    const computedSignature = await computeHmacSha256(secret, manifest)
    const signatureValid = timingSafeEqual(computedSignature, receivedSignature.toLowerCase())
    console.log(`signature_valid=${signatureValid}`)

    if (!signatureValid) {
      return Response.json({ ok: false, error: 'Invalid webhook signature' }, { status: 401 })
    }

    const accessToken = getEnv('MP_ACCESS_TOKEN')
    if (!accessToken) {
      console.log('processing_stage=missing_access_token')
      return Response.json({ ok: false, error: 'MP_ACCESS_TOKEN is not configured' }, { status: 500 })
    }

    console.log(`payment_id=${resolvedDataId}`)
    console.log('processing_stage=fetch_payment')

    let paymentResponse: Response
    try {
      paymentResponse = await fetchWithTimeout(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(resolvedDataId)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        },
        10_000,
      )
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'AbortError'
      console.log(`processing_stage=${timedOut ? 'payment_timeout' : 'payment_request_error'}`)
      return Response.json({ ok: false, error: timedOut ? 'Mercado Pago request timed out' : 'Mercado Pago request failed' }, { status: 502 })
    }

    console.log(`mercado_pago_http_status=${paymentResponse.status}`)

    if (paymentResponse.status === 404) {
      console.log('processing_stage=payment_not_found')
      return Response.json(
        { ok: true, processed: false, ignored: true, reason: 'Payment does not exist in Mercado Pago' },
        { status: 200 },
      )
    }

    if (!paymentResponse.ok) {
      console.log('processing_stage=payment_api_error')
      return Response.json({ ok: false, error: 'Mercado Pago payment request failed' }, { status: 502 })
    }

    let payment: Record<string, unknown>
    try {
      payment = await paymentResponse.json() as Record<string, unknown>
    } catch {
      console.log('processing_stage=payment_invalid_json')
      return Response.json({ ok: false, error: 'Invalid Mercado Pago response' }, { status: 502 })
    }

    const paymentDetails = {
      id: typeof payment.id === 'number' || typeof payment.id === 'string' ? String(payment.id) : null,
      status: typeof payment.status === 'string' ? payment.status : null,
      statusDetail: typeof payment.status_detail === 'string' ? payment.status_detail : null,
      transactionAmount: typeof payment.transaction_amount === 'number' ? payment.transaction_amount : null,
      currencyId: typeof payment.currency_id === 'string' ? payment.currency_id : null,
      externalReference: typeof payment.external_reference === 'string' ? payment.external_reference : null,
      paymentMethodId: typeof payment.payment_method_id === 'string' ? payment.payment_method_id : null,
      dateApproved: typeof payment.date_approved === 'string' ? payment.date_approved : null,
    }
    const paymentId = paymentDetails.id
    const paymentStatus = paymentDetails.status

    if (!paymentId || !paymentStatus || paymentId !== resolvedDataId) {
      console.log('processing_stage=payment_validation_failed')
      return Response.json({ ok: false, error: 'Invalid payment response' }, { status: 502 })
    }

    console.log(`payment_status=${paymentStatus}`)
    console.log(`has_external_reference=${Boolean(paymentDetails.externalReference)}`)
    console.log('processing_stage=payment_received')

    if (!paymentDetails.externalReference || paymentDetails.transactionAmount === null || !paymentDetails.currencyId) {
      console.log('processing_stage=payment_fields_missing')
      return Response.json({ ok: true, processed: false, ignored: true, reason: 'Payment lacks order linkage fields' }, { status: 200 })
    }

    const supabaseUrl = getEnv('SUPABASE_URL')
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      console.log('processing_stage=supabase_credentials_missing')
      return Response.json({ ok: false, error: 'Supabase server credentials are not configured' }, { status: 500 })
    }

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.53.0')
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id,status,total,currency,external_reference,paid_at')
      .eq('external_reference', paymentDetails.externalReference)
      .maybeSingle()

    if (orderError) {
      console.log('processing_stage=order_lookup_error')
      return Response.json({ ok: false, error: 'Order lookup failed' }, { status: 500 })
    }

    if (!order) {
      console.log('processing_stage=order_not_found')
      return Response.json({ ok: true, processed: false, ignored: true, reason: 'Order not found' }, { status: 200 })
    }

    const paymentAmount = paymentDetails.transactionAmount
    const orderAmount = toNumber(order.total)
    const currencyMatches = paymentDetails.currencyId === order.currency
    const amountMatches = orderAmount !== null && paymentAmount === orderAmount
    console.log(`order_id=${order.id}`)
    console.log(`amount_valid=${amountMatches}`)
    console.log(`currency_valid=${currencyMatches}`)

    if (!amountMatches || !currencyMatches) {
      console.log('processing_stage=payment_validation_mismatch')
      return Response.json({ ok: true, processed: false, ignored: true, reason: 'Payment amount or currency does not match order' }, { status: 200 })
    }

    const storedStatus = normalizePaymentStatus(paymentStatus)
    const orderStatus = mapOrderStatus(paymentStatus)
    const paymentRecord = {
      order_id: order.id,
      payment_id: paymentId,
      status: storedStatus,
      payment_method: paymentDetails.paymentMethodId,
      amount: paymentAmount,
      currency: paymentDetails.currencyId,
      provider: 'mercadopago',
      raw_payload: {
        id: paymentDetails.id,
        status: paymentDetails.status,
        status_detail: paymentDetails.statusDetail,
        transaction_amount: paymentDetails.transactionAmount,
        currency_id: paymentDetails.currencyId,
        external_reference: paymentDetails.externalReference,
        payment_method_id: paymentDetails.paymentMethodId,
        date_approved: paymentDetails.dateApproved,
      },
      updated_at: new Date().toISOString(),
    }

    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from('payments')
      .select('order_id,status')
      .eq('payment_id', paymentId)
      .maybeSingle()

    if (existingPaymentError) {
      console.log('processing_stage=payment_lookup_error')
      return Response.json({ ok: false, error: 'Payment lookup failed' }, { status: 500 })
    }

    if (existingPayment && existingPayment.order_id !== order.id) {
      console.log('processing_stage=payment_order_conflict')
      return Response.json({ ok: true, processed: false, ignored: true, reason: 'Payment belongs to another order' }, { status: 200 })
    }

    if (existingPayment?.status === 'approved' && storedStatus !== 'approved') {
      paymentRecord.status = 'approved'
    }

    let paymentWriteError: { message: string } | null = null
    if (existingPayment) {
      const result = await supabase
        .from('payments')
        .update(paymentRecord)
        .eq('payment_id', paymentId)
        .eq('order_id', order.id)
      paymentWriteError = result.error
    } else {
      const result = await supabase
        .from('payments')
        .insert(paymentRecord)
      paymentWriteError = result.error
    }

    if (paymentWriteError) {
      const { data: concurrentPayment } = await supabase
        .from('payments')
        .select('order_id,status')
        .eq('payment_id', paymentId)
        .maybeSingle()

      if (!concurrentPayment || concurrentPayment.order_id !== order.id) {
        console.log('processing_stage=payment_write_error')
        return Response.json({ ok: false, error: 'Payment write failed' }, { status: 500 })
      }

      console.log('processing_stage=payment_idempotent_retry')
    }

    const orderUpdate: Record<string, unknown> = {
      status: orderStatus,
      updated_at: new Date().toISOString(),
    }
    if (paymentStatus === 'approved' && !order.paid_at) {
      orderUpdate.paid_at = paymentDetails.dateApproved ?? new Date().toISOString()
    }

    if (order.status !== 'approved') {
      const { error: orderUpdateError } = await supabase
        .from('orders')
        .update(orderUpdate)
        .eq('id', order.id)
        .neq('status', 'approved')

      if (orderUpdateError) {
        console.log('processing_stage=order_update_error')
        return Response.json({ ok: false, error: 'Order update failed' }, { status: 500 })
      }
    }

    console.log(`idempotent=${Boolean(existingPayment)}`)
    console.log('processing_stage=completed')

    return Response.json(
      {
        ok: true,
        processed: true,
        payment_id: paymentId,
        payment_status: paymentStatus,
      },
      { status: 200 },
    )
  }

  return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 })
})
