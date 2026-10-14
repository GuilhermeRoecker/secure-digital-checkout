ALTER TABLE secure_checkout.orders
  ADD COLUMN IF NOT EXISTS payment_flow VARCHAR(30) NOT NULL DEFAULT 'HOSTED_CHECKOUT'
    CHECK (payment_flow IN ('HOSTED_CHECKOUT', 'DIRECT_3DS')),
  ADD COLUMN IF NOT EXISTS asaas_payment_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS orders_asaas_payment_id_uidx
  ON secure_checkout.orders (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL;

ALTER TABLE secure_checkout.webhook_events
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS billing_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS provider_created_at VARCHAR(40);
