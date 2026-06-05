-- Research-backed (idempotency §3, Postgres scaling §7).

-- Checkout idempotency: client-supplied key, unique per store. NULL key = no
-- constraint (multiple NULLs are allowed), so non-idempotent callers are
-- unaffected; a repeated key returns the same order instead of a duplicate.
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "order" ADD CONSTRAINT "order_store_idempotency" UNIQUE ("store_id", "idempotency_key");--> statement-breakpoint

-- Hot-path indexes for the admin list/sort + order-detail joins. FK columns are
-- NOT auto-indexed by Postgres; these back the queries that get slow first.
CREATE INDEX IF NOT EXISTS "order_store_state_created_idx" ON "order" ("store_id", "state", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_customer_idx" ON "order" ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_line_order_idx" ON "order_line" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_order_idx" ON "payment" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillment_order_idx" ON "fulfillment" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_store_name_idx" ON "product" ("store_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movement_variant_idx" ON "stock_movement" ("variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" ("entity", "entity_id");
