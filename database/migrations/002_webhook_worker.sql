ALTER TABLE secure_checkout.webhook_events
  ADD COLUMN IF NOT EXISTS checkout_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS webhook_events_pending_idx
  ON secure_checkout.webhook_events (next_attempt_at, id) WHERE status = 'RECEIVED';
