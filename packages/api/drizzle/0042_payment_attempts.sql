-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- Additive gateway provenance. Existing Stripe/imported rows stay unbound until
-- explicitly reconciled; no credentials or payment tokens are stored here.
ALTER TABLE payment ADD COLUMN gateway_account text;
ALTER TABLE payment ADD COLUMN gateway_mode text;
ALTER TABLE payment ADD COLUMN currency text;
--> statement-breakpoint
DROP INDEX IF EXISTS payment_store_provider_ref_uidx;
CREATE UNIQUE INDEX payment_store_provider_ref_uidx
  ON payment (store_id, method, coalesce(gateway_account, ''), coalesce(gateway_mode, ''), provider_ref)
  WHERE provider_ref IS NOT NULL;
--> statement-breakpoint
CREATE TABLE payment_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES store(id),
  order_id uuid NOT NULL REFERENCES "order"(id),
  payment_id uuid REFERENCES payment(id),
  operation text NOT NULL CHECK (operation IN ('charge','session','refund','capture','void')),
  method text NOT NULL,
  account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test','live')),
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','unknown','pending','settled','failed','cancelled')),
  provider_ref text,
  context jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempt_store_key UNIQUE (store_id, idempotency_key)
);
CREATE INDEX payment_attempt_order ON payment_attempt(store_id, order_id);
CREATE INDEX payment_attempt_unresolved ON payment_attempt(store_id, updated_at)
  WHERE status IN ('processing','unknown','pending');
ALTER TABLE payment_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON payment_attempt
  USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid);

--> statement-breakpoint
CREATE TABLE gateway_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES store(id),
  method text NOT NULL,
  account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test','live')),
  event_id text NOT NULL,
  event_type text NOT NULL,
  provider_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','manual')),
  attempts integer NOT NULL DEFAULT 0,
  details jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gateway_event_identity UNIQUE (store_id, method, account_id, mode, event_id)
);
CREATE INDEX gateway_event_pending ON gateway_event(store_id, status, updated_at);
ALTER TABLE gateway_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_event FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON gateway_event
  USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid);

--> statement-breakpoint
ALTER TYPE fulfillment_state ADD VALUE IF NOT EXISTS 'Cancelled';
ALTER TABLE fulfillment ADD COLUMN metadata jsonb;
ALTER TABLE refund ADD COLUMN metadata jsonb;
ALTER TABLE refund ADD COLUMN items_amount integer;
ALTER TABLE refund ADD COLUMN shipping_amount integer;
ALTER TABLE refund ADD COLUMN adjustment_amount integer;
