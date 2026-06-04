-- Row-Level Security: tenant isolation by store_id.
-- The app connects as a NON-OWNER role and sets `app.current_store` per request
-- transaction (SET LOCAL). current_setting(..., true) returns NULL when unset →
-- the predicate yields no rows → fail-closed (a request without a resolved store
-- sees and writes nothing). Owner/superuser bypass RLS, so migrations are unaffected.
--
-- EXCLUDED (intentionally, documented):
--   admin_user, session        — auth path, looked up by token/email BEFORE store context exists
--   processed_event            — idempotency, keyed by provider event id (global)
--   variant_option, collection_product, product_asset, variant_asset,
--   refund_line, fulfillment_line — child/join tables with no store_id; reachable
--                                 only via their store-scoped parents in app code.

-- store: the tenant root scopes on its own id
ALTER TABLE "store" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "store_isolation" ON "store" USING ("id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

-- store-scoped tables: scope on store_id
ALTER TABLE "admin_user_store" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_user_store" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "admin_user_store" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "asset" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "product_option_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_option_group" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product_option_group" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "product_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_option" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product_option" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "product_variant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_variant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product_variant" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "collection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "collection" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "address" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "address" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "shipping_method" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipping_method" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "shipping_method" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "promotion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "promotion" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "order_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_line" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "refund" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "refund" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "fulfillment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fulfillment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fulfillment" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "stock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_movement" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "affiliate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "affiliate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "affiliate" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "affiliate_settle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "affiliate_settle" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "affiliate_settle" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

ALTER TABLE "blog_post" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blog_post" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "blog_post" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);
