-- 0023_customer_tokens.sql — WP2d (one-time tokens for customer password-reset /
-- email-verify / set-password). Same model as staff_invite: hashed, TTL'd,
-- single-use. FORCE RLS like every other store-scoped table.
CREATE TABLE IF NOT EXISTS customer_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES store(id),
  customer_id uuid NOT NULL REFERENCES customer(id),
  kind        text NOT NULL CHECK (kind IN ('password_reset', 'email_verify', 'set_password')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_token_hash_idx ON customer_token (token_hash);
CREATE INDEX IF NOT EXISTS customer_token_store_customer_idx ON customer_token (store_id, customer_id);

ALTER TABLE customer_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_token FORCE  ROW LEVEL SECURITY;
CREATE POLICY customer_token_tenant ON customer_token
  USING (store_id = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.current_store', true), '')::uuid);
