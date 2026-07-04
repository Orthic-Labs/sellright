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
-- `payment` is under FORCE ROW LEVEL SECURITY, so even the owner sees zero rows
-- without a store context; de-dupe per store with app.current_store set (the same
-- tenant scoping the app uses), so this never touches another tenant's rows and
-- never has to weaken RLS.
DO $$
DECLARE s_id uuid;
BEGIN
  FOR s_id IN SELECT id FROM store LOOP
    PERFORM set_config('app.current_store', s_id::text, true);
    DELETE FROM payment p
      USING payment q
      WHERE p.store_id = q.store_id
        AND p.provider_ref = q.provider_ref
        AND p.provider_ref IS NOT NULL
        AND (p.created_at, p.id) > (q.created_at, q.id);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_store_provider_ref_uidx
  ON payment (store_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
