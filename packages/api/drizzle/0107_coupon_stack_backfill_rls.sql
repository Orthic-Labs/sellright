-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Repair 0104's coupon backfill for ordinary schema owners under FORCE RLS.
-- Repeat its exact eligibility per tenant without changing money or edit evidence.
DO $$
DECLARE
  tenant record;
  prior_store text := current_setting('app.current_store', true);
BEGIN
  FOR tenant IN SELECT id FROM store LOOP
    PERFORM set_config('app.current_store', tenant.id::text, true);
    UPDATE "order" o
    SET coupon_codes = ARRAY[p.code]
    FROM promotion p
    WHERE o.store_id = tenant.id
      AND o.promotion_id = p.id
      AND o.store_id = p.store_id
      AND cardinality(o.coupon_codes) = 0
      AND p.code IS NOT NULL
      AND p.code <> '';
  END LOOP;
  PERFORM set_config('app.current_store', coalesce(prior_store, ''), true);
END $$;
