-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- #446 backorder, restock trigger: "available" is the sellable quantity, so a restock event fires when on_hand + incoming -
-- allocated crosses 0 -> > 0 (incoming added to a sold-out variant, or stock returned), and the trigger also watches `incoming`.
-- A receive (on_hand += n, incoming -= n) leaves sellable unchanged and fires nothing, correct: it was already sellable.
-- A NEW function name (not CREATE OR REPLACE of 0049's stock_restock_event): replacing a function needs its ownership, and
-- on RightSites the old one is owned by the cluster superuser. The trigger belongs to the table (owned by the migration
-- role), so it is dropped and recreated on the new function; the old function stays, unused.
CREATE OR REPLACE FUNCTION stock_restock_event_sellable() RETURNS trigger AS $$
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
CREATE TRIGGER "stock_restock_event_trg" AFTER INSERT OR UPDATE OF "on_hand", "incoming", "allocated" ON "stock" FOR EACH ROW EXECUTE FUNCTION stock_restock_event_sellable();
-- DOWN (never run automatically): DROP TRIGGER stock_restock_event_trg ON stock; CREATE TRIGGER stock_restock_event_trg AFTER INSERT OR UPDATE OF on_hand, allocated ON stock FOR EACH ROW EXECUTE FUNCTION stock_restock_event(); DROP FUNCTION stock_restock_event_sellable();
