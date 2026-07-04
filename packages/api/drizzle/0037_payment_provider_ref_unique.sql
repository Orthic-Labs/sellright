-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- drizzle-kit does not model partial unique indexes (see the license_activation
-- precedent in schema-content.ts / migration 0027), so this index can never be
-- produced by `db:generate` and must be authored directly.

-- MONEY-1: prevent a settle race (POST /pay racing the Stripe webhook reconcile
-- path) from inserting two payment rows for the same captured charge. Partial —
-- WHERE provider_ref IS NOT NULL — so manual/COD payments (which have no
-- provider_ref) are never subject to the constraint and can coexist freely.

-- First reconcile any pre-existing settle-race duplicates: a DB that already ran
-- the racy path has >=2 payment rows sharing one (store_id, provider_ref) — these
-- are double-RECORDS of a SINGLE captured charge, not two charges. Keep the
-- earliest row per group and delete the extras; no money data is lost (the
-- surviving row is that same charge). On a clean DB (no duplicates) this is a
-- no-op. Without this step the CREATE UNIQUE INDEX below fails with 42P10
-- "Duplicate keys exist" on exactly the databases that carry the bug it fixes.
--
-- `payment` is under FORCE ROW LEVEL SECURITY, so even the table owner sees zero
-- rows from a bare query. Briefly drop FORCE for the owner-run de-dupe (this is a
-- cross-tenant data reconciliation the owner is entitled to make), then restore
-- it. Kept as separate statements so it is correct whether the migration runner
-- wraps the file in one transaction or autocommits each statement. store_id is
-- part of the key, so this never merges across tenants regardless of RLS.
ALTER TABLE "payment" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- FIRST null out the Woo→Vendure import placeholder. The original 2024 migration
-- stamped provider_ref='imported' on thousands of DISTINCT historical payments
-- (different orders/amounts/methods) that have no real gateway ref. They are NOT
-- duplicates of one charge — deleting all-but-one would destroy real payment
-- history. A placeholder ref belongs OUTSIDE the partial unique index (exactly
-- like manual/COD, which are NULL), so null it here. Then the de-dupe below only
-- ever touches genuine settle-race rows (a real gateway ref appearing twice).
UPDATE "payment" SET provider_ref = NULL WHERE provider_ref = 'imported';
--> statement-breakpoint
DELETE FROM "payment" p
  USING "payment" q
  WHERE p.store_id = q.store_id
    AND p.provider_ref = q.provider_ref
    AND p.provider_ref IS NOT NULL
    AND (p.created_at, p.id) > (q.created_at, q.id);
--> statement-breakpoint
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_store_provider_ref_uidx
  ON payment (store_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
