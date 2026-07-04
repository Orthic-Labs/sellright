-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- drizzle-kit does not model partial unique indexes (see the license_activation
-- precedent in schema-content.ts / migration 0027), so this index can never be
-- produced by `db:generate` and must be authored directly.

-- MONEY-1: prevent a settle race (POST /pay racing the Stripe webhook reconcile
-- path) from inserting two payment rows for the same captured charge. Partial —
-- WHERE provider_ref IS NOT NULL — so manual/COD payments (which have no
-- provider_ref) are never subject to the constraint and can coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS payment_store_provider_ref_uidx
  ON payment (store_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
