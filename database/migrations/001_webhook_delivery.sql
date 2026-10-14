CREATE SCHEMA IF NOT EXISTS secure_checkout;

CREATE INDEX IF NOT EXISTS orders_asaas_checkout_id_idx
  ON secure_checkout.orders (asaas_checkout_id)
  WHERE asaas_checkout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS secure_checkout.webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  checkout_id VARCHAR(100),
  payment_id VARCHAR(100),
  order_id BIGINT REFERENCES secure_checkout.orders (id),
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_order_received_idx
  ON secure_checkout.webhook_events (order_id, received_at DESC);

CREATE TABLE IF NOT EXISTS secure_checkout.digital_deliveries (
  id UUID PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES secure_checkout.orders (id),
  product_type VARCHAR(60) NOT NULL,
  delivery_code VARCHAR(40) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'BLOCKED'
    CHECK (status IN ('BLOCKED', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ
);
