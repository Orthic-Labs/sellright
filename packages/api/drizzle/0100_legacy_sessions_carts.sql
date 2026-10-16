-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Frozen Vendure capabilities & atomic cart receipts. Raw source tokens never persist.
ALTER TABLE session ADD COLUMN legacy_expires_at timestamptz;
CREATE TABLE legacy_session_grant (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES store(id),
  source_key text NOT NULL,
  source_session_id text NOT NULL,
  source_user_id text,
  source_customer_id text,
  source_email text,
  token_hash text NOT NULL,
  authenticated boolean NOT NULL,
  customer_id uuid REFERENCES customer(id) ON DELETE CASCADE,
  session_id uuid REFERENCES session(id) ON DELETE SET NULL,
  cart_id uuid REFERENCES cart(id) ON DELETE SET NULL,
  coupon_code text,
  country_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_grant_store_hash UNIQUE (store_id, token_hash),
  CONSTRAINT legacy_grant_source_session UNIQUE (store_id, source_key, source_session_id),
  CONSTRAINT legacy_grant_identity CHECK ((authenticated AND customer_id IS NOT NULL AND source_user_id IS NOT NULL AND source_customer_id IS NOT NULL) OR (NOT authenticated AND customer_id IS NULL AND session_id IS NULL AND source_user_id IS NULL))
);
CREATE TABLE legacy_cart_claim (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES store(id),
  claim_hash text NOT NULL,
  payload_hash text NOT NULL,
  grant_id uuid REFERENCES legacy_session_grant(id) ON DELETE CASCADE,
  source_only boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  cart_id uuid REFERENCES cart(id) ON DELETE SET NULL,
  coupon_code text,
  country_code text,
  unresolved jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_claim_store_hash UNIQUE (store_id, claim_hash)
);
CREATE UNIQUE INDEX legacy_claim_source_grant ON legacy_cart_claim(grant_id) WHERE source_only;
CREATE UNIQUE INDEX legacy_claim_grant ON legacy_cart_claim(grant_id) WHERE NOT source_only;
CREATE UNIQUE INDEX legacy_claim_cart ON legacy_cart_claim(cart_id) WHERE NOT source_only;
ALTER TABLE legacy_session_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_session_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_session_grant_store ON legacy_session_grant USING (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid) WITH CHECK (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid);
ALTER TABLE legacy_cart_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_cart_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_cart_claim_store ON legacy_cart_claim USING (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid) WITH CHECK (store_id = NULLIF(current_setting('app.current_store', true), '')::uuid);
