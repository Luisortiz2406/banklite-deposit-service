-- Datos de ejemplo de deposit_db (deposit-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- Recarga de Ana ya abonada: es la misma consignación de prueba del ledger
-- (ledger_transaction_id 7b000000-...-0001, $1.000.000). Los identificadores de Wompi son de mentira.
INSERT INTO public.deposits (id, reference, user_id, account_id, amount, amount_in_cents, currency, status, expires_at, wompi_transaction_id, payment_method_type, status_message, ledger_transaction_id, credited_at, last_checked_at, check_attempts, created_at, updated_at) VALUES
  ('45000000-0000-4000-8000-000000000001', 'BL-DEMO-0001', '11111111-1111-4111-8111-111111111111', '3a000000-0000-4000-8000-000000000001', 1000000, 100000000, 'COP', 'APPROVED', '2026-10-02 10:00:00-05', 'demo-wompi-0001', 'CARD', 'Transacción aprobada (demo)', '7b000000-0000-4000-8000-000000000001', '2026-10-01 10:00:00-05', '2026-10-01 10:00:00-05', 1, '2026-10-01 09:55:00-05', '2026-10-01 10:00:00-05')
ON CONFLICT DO NOTHING;

-- Recarga de Carlos creada pero sin pagar todavía (esperando el pago en Wompi).
INSERT INTO public.deposits (id, reference, user_id, account_id, amount, amount_in_cents, currency, status, expires_at, created_at, updated_at) VALUES
  ('45000000-0000-4000-8000-000000000002', 'BL-DEMO-0002', '22222222-2222-4222-8222-222222222222', '3a000000-0000-4000-8000-000000000002', 50000, 5000000, 'COP', 'PENDING', '2026-10-05 12:00:00-05', '2026-10-04 12:00:00-05', '2026-10-04 12:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
