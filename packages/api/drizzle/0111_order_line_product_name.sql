-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Product name on order lines (issue #346). order_line kept only variant_name ("Medium - Midnight black"), so emails,
-- invoices, the admin and the confirmation page could not say which product was bought. Adds the nullable snapshot
-- order_line.product_name, filled by a BEFORE INSERT / UPDATE OF variant_id trigger from the line's variant, so every
-- writer (checkout, admin-created orders, order edits, subscriptions) records it without code changes and a later
-- product rename never rewrites history. NULL stays legal: imported lines carry the product inside
-- variant_name, and a line whose variant is gone keeps what it had. Readers compose "Product · Variant"
-- (orders/line-label.ts). Additive: the previous image never reads the column, and its inserts are filled by the same
-- trigger, so a rollback runs unchanged. The trigger runs as the invoker under the tenant's RLS context (it can only
-- see the order's own store) and checks store_id explicitly as well.
ALTER TABLE "order_line" ADD COLUMN "product_name" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_line_snapshot_product_name() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL AND (TG_OP = 'INSERT' AND NEW.product_name IS NULL
      OR TG_OP = 'UPDATE' AND NEW.variant_id IS DISTINCT FROM OLD.variant_id) THEN
    SELECT p.name INTO NEW.product_name
      FROM product_variant v JOIN product p ON p.id = v.product_id
     WHERE v.id = NEW.variant_id AND v.store_id = NEW.store_id AND p.store_id = NEW.store_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "order_line_snapshot_product_name" BEFORE INSERT OR UPDATE OF "variant_id" ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION order_line_snapshot_product_name();--> statement-breakpoint
-- Backfill per tenant under FORCE RLS (same pattern as 0107/0109). Lines whose variant_name already starts with the
-- product name (imported history) are left NULL: the name is already there.
DO $$
DECLARE
  tenant record;
  prior_store text := current_setting('app.current_store', true);
BEGIN
  FOR tenant IN SELECT id FROM store LOOP
    PERFORM set_config('app.current_store', tenant.id::text, true);
    UPDATE order_line ol SET product_name = p.name
      FROM product_variant v JOIN product p ON p.id = v.product_id
     WHERE ol.store_id = tenant.id AND ol.product_name IS NULL AND ol.variant_id = v.id
       AND v.store_id = tenant.id AND p.store_id = tenant.id
       AND lower(ol.variant_name) NOT LIKE lower(p.name) || '%';
  END LOOP;
  PERFORM set_config('app.current_store', coalesce(prior_store, ''), true);
END $$;
-- DOWN (never run automatically): DROP TRIGGER order_line_snapshot_product_name ON order_line;
--   DROP FUNCTION order_line_snapshot_product_name(); ALTER TABLE order_line DROP COLUMN product_name;
