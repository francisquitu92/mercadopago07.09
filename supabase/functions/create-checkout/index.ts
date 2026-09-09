type CheckoutItemInput = {
  product_id?: unknown
  quantity?: unknown
}

type ProductRow = {
  id: string
  name: string
  description: string
  price: number | string
  currency: string
  is_active: boolean
}

type PreferenceItem = {
  id: string
  title: string
  description: string
  quantity: number
  unit_price: number
  currency_id: string
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonResponse = (body: Record<string, unknown>, status: number): Response =>
  Response.json(body, { status, headers: corsHeaders })

const getEnv = (name: string): string | undefined => Deno.env.get(name) ?? undefined

const parseBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await request.json()
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

const parseItems = (value: unknown): { items: Array<{ productId: string; quantity: number }> } | { error: string } => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    return { error: 'Cart must contain between 1 and 50 items' }
  }

  const merged = new Map<string, number>()
  for (const item of value as CheckoutItemInput[]) {
    const productId = typeof item.product_id === 'string' ? item.product_id.trim() : ''
    const quantity = typeof item.quantity === 'number' && Number.isInteger(item.quantity)
      ? item.quantity
      : NaN

    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      return { error: 'Each item requires a valid product_id and quantity' }
    }

    merged.set(productId, (merged.get(productId) ?? 0) + quantity)
  }

  return { items: Array.from(merged, ([productId, quantity]) => ({ productId, quantity })) }
}

const getBearerToken = (request: Request): string | null => {
  const header = request.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = getEnv('SUPABASE_URL')
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
  const accessToken = getEnv('MP_ACCESS_TOKEN')
  const appBaseUrl = getEnv('APP_BASE_URL')

  console.log(`SUPABASE_URL_PRESENT=${Boolean(supabaseUrl)}`)
  console.log(`SUPABASE_SERVICE_ROLE_KEY_PRESENT=${Boolean(serviceRoleKey)}`)
  console.log(`MP_ACCESS_TOKEN_PRESENT=${Boolean(accessToken)}`)
  console.log(`APP_BASE_URL_PRESENT=${Boolean(appBaseUrl)}`)

  if (!supabaseUrl || !serviceRoleKey || !accessToken || !appBaseUrl) {
    return jsonResponse({ ok: false, error: 'Checkout service is not configured' }, 500)
  }

  const body = await parseBody(request)
  if (!body) {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400)
  }

  const parsedItems = parseItems(body.items)
  if ('error' in parsedItems) {
    return jsonResponse({ ok: false, error: parsedItems.error }, 400)
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.53.0')
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const productIds = parsedItems.items.map((item) => item.productId)
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id,name,description,price,currency,is_active')
    .in('id', productIds)

  if (productsError) {
    console.log('stage=products_lookup_error')
    return jsonResponse({ ok: false, error: 'Unable to validate products' }, 500)
  }

  const productMap = new Map((products as ProductRow[] | null ?? []).map((product) => [product.id, product]))
  const preferenceItems: PreferenceItem[] = []
  let subtotal = 0
  let currency: string | null = null

  for (const requested of parsedItems.items) {
    const product = productMap.get(requested.productId)
    if (!product) {
      return jsonResponse({ ok: false, error: 'Product not found' }, 404)
    }
    if (!product.is_active) {
      return jsonResponse({ ok: false, error: 'Product is inactive' }, 409)
    }

    const unitPrice = Number(product.price)
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || !product.currency) {
      return jsonResponse({ ok: false, error: 'Product pricing is invalid' }, 500)
    }
    if (currency && currency !== product.currency) {
      return jsonResponse({ ok: false, error: 'Cart currencies do not match' }, 400)
    }

    currency = product.currency
    const itemSubtotal = unitPrice * requested.quantity
    subtotal += itemSubtotal
    preferenceItems.push({
      id: product.id,
      title: product.name,
      description: product.description,
      quantity: requested.quantity,
      unit_price: unitPrice,
      currency_id: product.currency,
    })
  }

  if (!currency || !Number.isFinite(subtotal) || subtotal <= 0) {
    return jsonResponse({ ok: false, error: 'Cart total is invalid' }, 400)
  }

  const token = getBearerToken(request)
  if (!token) {
    return jsonResponse({ ok: false, error: 'Authentication required' }, 401)
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token)
  if (userError || !userData.user) {
    return jsonResponse({ ok: false, error: 'Authentication required' }, 401)
  }

  const userId = userData.user.id
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    console.log('stage=profile_lookup_error')
    return jsonResponse({ ok: false, error: 'Unable to validate account' }, 500)
  }

  if (!profile) {
    return jsonResponse({ ok: false, error: 'Account profile is not ready' }, 409)
  }

  const idempotencyKey = request.headers.get('x-idempotency-key')?.trim() || crypto.randomUUID()
  const externalReference = `order_${userId}_${idempotencyKey}`
  const baseUrl = appBaseUrl.replace(/\/$/, '')
  const notificationUrl = 'https://dyxdhfommhxsglggqdkt.supabase.co/functions/v1/mercado-pago-webhook'

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from('orders')
    .select('id,external_reference,preference_id,status')
    .eq('external_reference', externalReference)
    .maybeSingle()

  if (existingOrderError) {
    return jsonResponse({ ok: false, error: 'Unable to check checkout idempotency' }, 500)
  }

  if (existingOrder?.preference_id && existingOrder.status === 'pending_payment') {
    const existingPreferenceResponse = await fetch(`https://api.mercadopago.com/checkout/preferences/${encodeURIComponent(existingOrder.preference_id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (existingPreferenceResponse.ok) {
      const existingPreference = await existingPreferenceResponse.json() as Record<string, unknown>
      const existingCheckoutUrl = typeof existingPreference.sandbox_init_point === 'string'
        ? existingPreference.sandbox_init_point
        : typeof existingPreference.init_point === 'string'
          ? existingPreference.init_point
          : null
      if (existingCheckoutUrl) {
        return jsonResponse({
          success: true,
          order_id: existingOrder.id,
          external_reference: existingOrder.external_reference,
          preference_id: existingOrder.preference_id,
          checkout_url: existingCheckoutUrl,
        }, 200)
      }
    }
  }

  const order = existingOrder
    ? existingOrder
    : (await supabase
      .from('orders')
      .insert({
        user_id: userId,
        status: 'pending_payment',
        subtotal,
        total: subtotal,
        currency,
        external_reference: externalReference,
      })
      .select('id,external_reference,preference_id,status')
      .single()).data

  if (!order) {
    console.log('stage=order_create_error')
    return jsonResponse({ ok: false, error: 'Unable to create order' }, 500)
  }

  if (!existingOrder) {
    const { error: itemsError } = await supabase
      .from('order_items')
      .insert(preferenceItems.map((item) => ({
        order_id: order.id,
        product_id: item.id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        subtotal: item.unit_price * item.quantity,
      })))

    if (itemsError) {
      await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', order.id)
      console.log('stage=order_items_create_error')
      return jsonResponse({ ok: false, error: 'Unable to create order items' }, 500)
    }
  }

  const preferenceResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      items: preferenceItems,
      external_reference: externalReference,
      back_urls: {
        success: `${baseUrl}/checkout/success`,
        failure: `${baseUrl}/checkout/failure`,
        pending: `${baseUrl}/checkout/pending`,
      },
      notification_url: notificationUrl,
      auto_return: 'approved',
    }),
  })

  if (!preferenceResponse.ok) {
    await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', order.id)
    console.log(`stage=preference_create_error http_status=${preferenceResponse.status}`)
    return jsonResponse({ ok: false, error: 'Unable to create checkout preference' }, 502)
  }

  const preference = await preferenceResponse.json() as Record<string, unknown>
  const preferenceId = typeof preference.id === 'string' ? preference.id : null
  const checkoutUrl = typeof preference.sandbox_init_point === 'string'
    ? preference.sandbox_init_point
    : typeof preference.init_point === 'string'
      ? preference.init_point
      : null

  if (!preferenceId || !checkoutUrl) {
    await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', order.id)
    return jsonResponse({ ok: false, error: 'Mercado Pago returned an invalid preference' }, 502)
  }

  const { error: preferenceUpdateError } = await supabase
    .from('orders')
    .update({ preference_id: preferenceId, status: 'pending_payment', updated_at: new Date().toISOString() })
    .eq('id', order.id)

  if (preferenceUpdateError) {
    await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', order.id)
    return jsonResponse({ ok: false, error: 'Unable to save checkout preference' }, 500)
  }

  return jsonResponse({
    success: true,
    order_id: order.id,
    external_reference: externalReference,
    preference_id: preferenceId,
    checkout_url: checkoutUrl,
  }, 200)
})
