-- Datos de prueba seguros y no personales.
-- Estos productos son de ejemplo para desarrollo local.

insert into public.products (id, name, slug, description, price, currency, is_active)
values
  (gen_random_uuid(), 'Curso de Fundamentos Web', 'curso-fundamentos-web', 'Aprende HTML, CSS y JavaScript para construir interfaces modernas.', 49000, 'CLP', true),
  (gen_random_uuid(), 'Plan de Consultoría UX', 'plan-consultoria-ux', 'Diagnóstico inicial de experiencia de usuario para producto digital.', 120000, 'CLP', true),
  (gen_random_uuid(), 'Membresía de Soporte Mensual', 'membresia-soporte-mensual', 'Acompañamiento técnico y soporte para actualizaciones del producto.', 34990, 'CLP', true)
on conflict (slug) do nothing;
