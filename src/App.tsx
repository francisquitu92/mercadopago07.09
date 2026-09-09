import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { fallbackProducts } from './data/products'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import type { CartItem, Product } from './types'
import type { Session } from '@supabase/supabase-js'

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value)

const addItemToCart = (cart: CartItem[], product: Product): CartItem[] => {
  const existing = cart.find((item) => item.id === product.id)

  if (existing) {
    return cart.map((item) =>
      item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item,
    )
  }

  return [...cart, { ...product, quantity: 1 }]
}

const removeItemFromCart = (cart: CartItem[], productId: string): CartItem[] =>
  cart
    .map((item) =>
      item.id === productId ? { ...item, quantity: item.quantity - 1 } : item,
    )
    .filter((item) => item.quantity > 0)

function App() {
  const [catalog, setCatalog] = useState<Product[]>(fallbackProducts)
  const [loading, setLoading] = useState(true)
  const [cart, setCart] = useState<CartItem[]>([])
  const [orderStatus, setOrderStatus] = useState('draft')
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return
    }

    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const loadProducts = async () => {
      if (!isSupabaseConfigured) {
        setCatalog(fallbackProducts)
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })

      if (error) {
        console.error('Supabase products fetch error:', error)
        setCatalog(fallbackProducts)
        setLoading(false)
        return
      }

      const normalizedProducts = (data ?? []).map((product: Product) => ({
        ...product,
        image: product.image ?? 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=900&q=80',
      }))

      setCatalog(normalizedProducts.length > 0 ? normalizedProducts : fallbackProducts)
      setLoading(false)
    }

    void loadProducts()
  }, [])

  const subtotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [cart],
  )

  const checkout = async () => {
    if (cart.length === 0 || checkoutLoading) {
      return
    }

    setCheckoutLoading(true)
    setCheckoutError(null)

    const { data, error } = await supabase.functions.invoke('create-checkout', {
      body: {
        items: cart.map((item) => ({
          product_id: item.id,
          quantity: item.quantity,
        })),
      },
      headers: {
        'x-idempotency-key': crypto.randomUUID(),
      },
    })

    if (error || !data?.checkout_url) {
      setCheckoutError(error?.message ?? 'No se pudo iniciar el checkout.')
      setCheckoutLoading(false)
      return
    }

    setOrderStatus('pending_payment')
    window.location.assign(data.checkout_url)
  }

  const signUp = async () => {
    setAuthBusy(true)
    setAuthMessage(null)
    const { error, data } = await supabase.auth.signUp({
      email: authEmail.trim(),
      password: authPassword,
    })
    setAuthBusy(false)
    if (error) {
      setAuthMessage(error.message)
      return
    }
    setAuthMessage(data.session ? 'Cuenta creada.' : 'Cuenta creada. Revisa tu correo para confirmarla.')
  }

  const signIn = async () => {
    setAuthBusy(true)
    setAuthMessage(null)
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    })
    setAuthBusy(false)
    if (error) {
      setAuthMessage(error.message)
    }
  }

  const signOut = async () => {
    setAuthBusy(true)
    const { error } = await supabase.auth.signOut()
    setAuthBusy(false)
    setAuthMessage(error?.message ?? null)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Supabase + Mercado Pago base</p>
          <h1>Marketplace demo</h1>
        </div>
        <div className="cart-pill">Carrito: {cart.reduce((sum, item) => sum + item.quantity, 0)}</div>
      </header>

      <section className="auth-panel" aria-label="Autenticación">
        {session?.user ? (
          <div className="auth-session">
            <span>Sesión: {session.user.email}</span>
            <button type="button" onClick={signOut} disabled={authBusy}>Cerrar sesión</button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={(event) => event.preventDefault()}>
            <label>
              Email
              <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} minLength={6} required />
            </label>
            <div className="auth-actions">
              <button type="button" onClick={signUp} disabled={authBusy}>Crear cuenta</button>
              <button type="button" onClick={signIn} disabled={authBusy}>Iniciar sesión</button>
            </div>
          </form>
        )}
        {authMessage ? <p className="auth-message" role="status">{authMessage}</p> : null}
      </section>

      <main className="content-grid">
        <section className="catalog">
          <div className="section-heading">
            <h2>Productos</h2>
          </div>

          {loading ? (
            <p className="empty-state">Cargando productos…</p>
          ) : (
            <div className="product-grid">
              {catalog.map((product) => (
                <article key={product.id} className="product-card">
                  <img src={product.image ?? 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=900&q=80'} alt={product.name} />
                  <div className="product-info">
                    <h3>{product.name}</h3>
                    <p>{product.description}</p>
                    <div className="product-footer">
                      <strong>{formatCurrency(product.price)}</strong>
                      <button type="button" onClick={() => setCart((current) => addItemToCart(current, product))}>
                        Agregar
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="cart-panel">
          <div className="section-heading">
            <h2>Carrito</h2>
          </div>

          {cart.length === 0 ? (
            <p className="empty-state">Sin productos aún.</p>
          ) : (
            <ul className="cart-list">
              {cart.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>
                      {item.quantity} × {formatCurrency(item.price)}
                    </span>
                  </div>
                  <button type="button" onClick={() => setCart((current) => removeItemFromCart(current, item.id))}>
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="summary-box">
            <div>
              <span>Subtotal</span>
              <strong>{formatCurrency(subtotal)}</strong>
            </div>
            <div>
              <span>Estado</span>
              <strong>{orderStatus}</strong>
            </div>
          </div>

          {checkoutError ? <p className="error-state" role="alert">{checkoutError}</p> : null}

          <button
            type="button"
            className="checkout-button"
            disabled={cart.length === 0 || checkoutLoading || !session}
            onClick={checkout}
          >
            {checkoutLoading ? 'Preparando checkout…' : 'Ir a checkout'}
          </button>
        </aside>
      </main>
    </div>
  )
}

export default App
