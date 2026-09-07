import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { fallbackProducts } from './data/products'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import type { CartItem, Product } from './types'

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

      const normalizedProducts = (data ?? []).map((product) => ({
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

  const checkout = () => {
    setOrderStatus('pending_payment')
    console.info('Checkout ready: order creation and Mercado Pago preference generation will happen in backend later.')
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

          <button
            type="button"
            className="checkout-button"
            disabled={cart.length === 0}
            onClick={checkout}
          >
            Ir a checkout
          </button>
        </aside>
      </main>
    </div>
  )
}

export default App
