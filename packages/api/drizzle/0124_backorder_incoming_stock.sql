-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- #446 backorder: `stock.incoming` = units not in the warehouse yet (e.g. at the factory) that may be sold ahead of
-- arrival; `product_variant.backorder_label` = per-variant ship copy ("Ships in 3 weeks"), required by the API whenever
-- incoming > 0. Sellable = on_hand + incoming - allocated; ships-now = greatest(on_hand - allocated, 0). Additive with
-- constant defaults (no table rewrite on PG11+): the previous image never reads either column and keeps selling
-- on_hand - allocated, which is a subset of the new rule. Hand-written because the drizzle snapshot history is stale
-- (same reason as 0072/0082).
ALTER TABLE "stock" ADD COLUMN IF NOT EXISTS "incoming" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "stock" DROP CONSTRAINT IF EXISTS "stock_incoming_nonneg";--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_incoming_nonneg" CHECK ("incoming" >= 0);--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "backorder_label" text;
-- Restock trigger (0049): "available" is now the sellable quantity, so a restock event fires when on_hand + incoming -
-- allocated crosses 0 -> > 0 (incoming added to a sold-out variant, or a receive) and the trigger also watches `incoming`.
-- A receive (on_hand += n, incoming -= n) leaves sellable unchanged and fires nothing, correct: it was already sellable.
CREATE OR REPLACE FUNCTION stock_restock_event() RETURNS trigger AS $$
DECLARE
	old_available int;
BEGIN
	old_available := CASE WHEN TG_OP = 'UPDATE'
		THEN coalesce(OLD.on_hand, 0) + coalesce(OLD.incoming, 0) - coalesce(OLD.allocated, 0)
		ELSE 0 END;
	IF (coalesce(NEW.on_hand, 0) + coalesce(NEW.incoming, 0) - coalesce(NEW.allocated, 0)) > 0 AND old_available <= 0 THEN
		INSERT INTO restock_event (store_id, variant_id)
		VALUES (NEW.store_id, NEW.variant_id)
		ON CONFLICT (variant_id) WHERE processed_at IS NULL DO NOTHING;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "stock_restock_event_trg" ON "stock";--> statement-breakpoint
CREATE TRIGGER "stock_restock_event_trg" AFTER INSERT OR UPDATE OF "on_hand", "incoming", "allocated" ON "stock" FOR EACH ROW EXECUTE FUNCTION stock_restock_event();
-- DOWN (never run automatically): ALTER TABLE stock DROP CONSTRAINT stock_incoming_nonneg; ALTER TABLE stock DROP COLUMN incoming; ALTER TABLE product_variant DROP COLUMN backorder_label; (then restore the 0049 stock_restock_event() body and trigger column list; only after the new image is rolled back; backordered orders keep allocated > on_hand until received)
