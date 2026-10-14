CREATE SCHEMA IF NOT EXISTS secure_checkout;

CREATE TABLE IF NOT EXISTS secure_checkout.orders (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE,
  customer_name VARCHAR(100) NOT NULL,
  customer_email VARCHAR(254) NOT NULL,
  customer_document VARCHAR(14) NOT NULL,
  customer_phone VARCHAR(13) NOT NULL,
  product_name VARCHAR(100) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  status VARCHAR(40) NOT NULL DEFAULT 'CREATED',
  asaas_checkout_id VARCHAR(100),
  asaas_checkout_url TEXT,
  failure_code VARCHAR(100),
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx
  ON secure_checkout.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx
  ON secure_checkout.orders (status);

CREATE TABLE IF NOT EXISTS secure_checkout.order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES secure_checkout.orders (id) ON DELETE CASCADE,
  event_type VARCHAR(60) NOT NULL,
  description VARCHAR(300) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_events_order_created_idx
  ON secure_checkout.order_events (order_id, created_at ASC);

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

ALTER TABLE secure_checkout.webhook_events
  ADD COLUMN IF NOT EXISTS checkout_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS webhook_events_pending_idx
  ON secure_checkout.webhook_events (next_attempt_at, id) WHERE status = 'RECEIVED';
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
