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
-- 2026-11-10: the restock trigger change that first shipped in this file moved to 0125 (a new function name), because
-- CREATE OR REPLACE FUNCTION stock_restock_event() fails where that function is owned by another role (RightSites:
-- owned by the cluster superuser, "must be owner of function"). A database that already ran the earlier 0124 (demo) has
-- the replaced body and then gets 0125 like every other database; both end with the trigger on the 0125 function.
-- DOWN (never run automatically): ALTER TABLE stock DROP CONSTRAINT stock_incoming_nonneg; ALTER TABLE stock DROP COLUMN incoming; ALTER TABLE product_variant DROP COLUMN backorder_label; (only after the new image is rolled back; backordered orders keep allocated > on_hand until received)
