-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Credit is a discount coupon with a mutable balance and durable monetary holds.
-- Historical source rows are snapshots; migration must never replay their deltas.
ALTER TYPE promotion_type ADD VALUE IF NOT EXISTS 'account_credit';

CREATE TABLE account_credit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES store(id),
  promotion_id uuid NOT NULL REFERENCES promotion(id),
  currency text NOT NULL, email_normalized text NOT NULL, issuance_key text NOT NULL,
  initial_amount integer NOT NULL, balance integer NOT NULL, disabled boolean NOT NULL DEFAULT false,
  source_key text, source_id text, source_digest text, source_record text,
  source_promotion_record text, source_created_at text, source_updated_at text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_credit_store_promotion UNIQUE(store_id, promotion_id),
  CONSTRAINT account_credit_store_issuance UNIQUE(store_id, issuance_key),
  CONSTRAINT account_credit_source_identity UNIQUE(store_id, source_key, source_id),
  CONSTRAINT account_credit_amounts CHECK(initial_amount >= 0 AND balance >= 0)
);
CREATE TABLE account_credit_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL REFERENCES store(id),
  account_credit_id uuid NOT NULL REFERENCES account_credit(id), kind text NOT NULL, status text NOT NULL,
  amount integer NOT NULL, delta integer NOT NULL, balance_after integer,
  related_transaction_id uuid REFERENCES account_credit_transaction(id), idempotency_key text NOT NULL,
  reason text, actor text, order_id uuid REFERENCES "order"(id) ON DELETE SET NULL, order_code text,
  refund_id uuid REFERENCES refund(id) ON DELETE SET NULL, order_line_id uuid REFERENCES order_line(id) ON DELETE SET NULL,
  source_order_id text, source_refund_id text, source_order_line_id text, quantity integer,
  allocation text, operational_allocation jsonb,
  source_key text, source_id text, source_digest text, source_record text, source_created_at text, source_updated_at text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_credit_transaction_store_key UNIQUE(store_id, idempotency_key),
  CONSTRAINT account_credit_transaction_source_identity UNIQUE(store_id, source_key, source_id),
  CONSTRAINT account_credit_transaction_kind CHECK(kind IN ('ISSUE','ADJUST','DISABLE','ENABLE','RESERVE','RELEASE','REDEEM','RESTORE')),
  CONSTRAINT account_credit_transaction_status CHECK(status IN ('PENDING','POSTED','VOID')),
  CONSTRAINT account_credit_transaction_amounts CHECK(amount >= 0 AND delta >= -2147483647 AND (balance_after IS NULL OR balance_after >= 0) AND (quantity IS NULL OR quantity >= 0)),
  CONSTRAINT account_credit_transaction_pending CHECK(status <> 'PENDING' OR (kind = 'RESERVE' AND amount > 0))
);
CREATE UNIQUE INDEX account_credit_pending_order ON account_credit_transaction(store_id, order_id) WHERE kind = 'RESERVE' AND status = 'PENDING';
CREATE INDEX account_credit_transaction_account ON account_credit_transaction(store_id, account_credit_id);
CREATE INDEX account_credit_transaction_order ON account_credit_transaction(store_id, order_id);

ALTER TABLE account_credit ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_credit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_credit
  USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid);
ALTER TABLE account_credit_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_credit_transaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_credit_transaction
  USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid);
-- Runtime grants follow schema-owner default privileges (postgres-app-role runbook).
