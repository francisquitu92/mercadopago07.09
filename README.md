# Mercado Pago Base App

Aplicación base creada con React + Vite + TypeScript, lista para evolucionar con Supabase y Mercado Pago Checkout Pro.

## Stack propuesto

- Frontend: React + Vite + TypeScript
- Base de datos: Supabase PostgreSQL
- Backend: Supabase Edge Functions / backend server-side seguro
- Pago: Mercado Pago Checkout Pro (integración futura)

## Estructura inicial

- src/data/products.ts
- src/lib/supabase.ts
- src/types.ts
- supabase/schema.sql
- .env.example

## Seguridad

- Los secretos de Mercado Pago y Supabase Service Role no deben exponerse al frontend.
- La validación del pago y la creación de la Preference deben vivir en backend.
- El frontend no debe decidir si un pedido está pagado.

## Cómo ejecutar

1. npm install
2. npm run dev
3. abrir la app en http://localhost:5173

## Qué falta para Mercado Pago

- endpoint backend para crear preference
- webhook para validar notificaciones
- consulta real de pago
- base de datos real y migraciones
- autenticación / usuarios reales
- deployment con Supabase o servidor backend
