import type { Product } from '../types'

export const fallbackProducts: Product[] = [
  {
    id: 'prod_101',
    name: 'Curso de Fundamentos Web',
    slug: 'curso-fundamentos-web',
    description: 'Aprende HTML, CSS y JavaScript para construir interfaces modernas.',
    price: 49000,
    currency: 'CLP',
    is_active: true,
    image: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80',
  },
  {
    id: 'prod_102',
    name: 'Plan de Consultoría UX',
    slug: 'plan-consultoria-ux',
    description: 'Diagnóstico inicial de experiencia de usuario para producto digital.',
    price: 120000,
    currency: 'CLP',
    is_active: true,
    image: 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=900&q=80',
  },
  {
    id: 'prod_103',
    name: 'Membresía de Soporte Mensual',
    slug: 'membresia-soporte-mensual',
    description: 'Acompañamiento técnico y soporte para actualizaciones del producto.',
    price: 34990,
    currency: 'CLP',
    is_active: true,
    image: 'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=900&q=80',
  },
]
