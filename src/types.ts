export type Product = {
  id: string
  name: string
  slug: string
  description: string
  price: number
  currency: 'CLP'
  is_active: boolean
  image?: string
  created_at?: string
  updated_at?: string
}

export type CartItem = Product & {
  quantity: number
}

export type OrderStatus = 'draft' | 'pending_payment' | 'approved' | 'rejected' | 'cancelled'

export type OrderSummary = {
  id: string
  status: OrderStatus
  total: number
  currency: 'CLP'
  createdAt: string
}

export type Profile = {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export type Order = {
  id: string
  user_id: string
  status: OrderStatus
  subtotal: number
  total: number
  currency: 'CLP'
  external_reference: string | null
  preference_id: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

export type OrderItem = {
  id: string
  order_id: string
  product_id: string
  quantity: number
  unit_price: number
  subtotal: number
  created_at: string
}

export type Payment = {
  id: string
  order_id: string
  payment_id: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  payment_method: string | null
  amount: number
  currency: 'CLP'
  provider: 'mercadopago'
  raw_payload: Record<string, unknown> | null
  created_at: string
  updated_at: string
}
