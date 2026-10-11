-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0096: single-use ledger for federated sign-in confirmation links (Google now, Apple next; auth/federated-link.ts).
-- The link is a stateless signed token carrying a random jti; redeeming it inserts sha256(jti) here, and the PRIMARY KEY
-- turns a second redemption into a conflict (ON CONFLICT DO NOTHING returns no row -> the caller answers 401).
-- Rows only need to outlive the token (30 min); expires_at lets a sweep or manual cleanup drop them. Expand-only new table.
-- RLS matches the other store-scoped tables: tenant_isolation, FORCE (nullif so an empty app.current_store sees nothing).
-- Rollback: DROP TABLE federated_link_redemption.
CREATE TABLE IF NOT EXISTS "federated_link_redemption" (
  "store_id"    uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "jti_hash"    text NOT NULL,
  "expires_at"  timestamp with time zone NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("store_id", "jti_hash")
);

CREATE INDEX IF NOT EXISTS "federated_link_redemption_expires_idx" ON "federated_link_redemption" ("expires_at");

ALTER TABLE "federated_link_redemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "federated_link_redemption" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "federated_link_redemption";
CREATE POLICY "tenant_isolation" ON "federated_link_redemption"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
