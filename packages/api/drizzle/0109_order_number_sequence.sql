-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Sequential, store-configurable order numbers (issue #309). Additive: one row per store with the code format
-- (prefix, suffix, minimum digits) and the next number; orders/order-number.ts takes the number inside the order-insert
-- transaction. Existing orders keep their codes. Every existing store is seeded with the default format (no prefix,
-- no suffix, no padding) and a next number after its highest digits-only code, never below 1001. A store created later
-- gets its row on its first order. The previous image never reads this table, so a rollback runs unchanged.
-- Runtime grants follow schema-owner default privileges (postgres-app-role runbook).
CREATE TABLE "order_number_sequence" (
  "store_id" uuid PRIMARY KEY REFERENCES "store"("id") ON DELETE CASCADE,
  "prefix" text NOT NULL DEFAULT '',
  "suffix" text NOT NULL DEFAULT '',
  "min_digits" integer NOT NULL DEFAULT 0,
  "next_number" bigint NOT NULL DEFAULT 1001,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_number_sequence_min_digits" CHECK ("min_digits" BETWEEN 0 AND 12),
  CONSTRAINT "order_number_sequence_next_number" CHECK ("next_number" >= 1)
);--> statement-breakpoint
ALTER TABLE "order_number_sequence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_number_sequence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_number_sequence" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
-- Seed per tenant under FORCE RLS (same pattern as 0107): the schema owner sees a tenant's orders only with its context.
DO $$
DECLARE
  tenant record;
  highest numeric;
  prior_store text := current_setting('app.current_store', true);
BEGIN
  FOR tenant IN SELECT id FROM store LOOP
    PERFORM set_config('app.current_store', tenant.id::text, true);
    SELECT max(code::numeric) INTO highest FROM "order" WHERE store_id = tenant.id AND code ~ '^[0-9]+$';
    INSERT INTO order_number_sequence (store_id, next_number)
    VALUES (tenant.id, greatest(1001, least(coalesce(highest, 0) + 1, 999999999999)))
    ON CONFLICT (store_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_store', coalesce(prior_store, ''), true);
END $$;
-- DOWN (never run automatically): DROP TABLE order_number_sequence;
