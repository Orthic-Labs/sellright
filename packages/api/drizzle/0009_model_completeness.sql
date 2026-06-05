-- Gap fixes from the DB relationship review (2026-06-05).
-- Policy expression matches the hardened form (0002): fail-closed nullif().

-- ── 1) Promotions: applied-promo linkage on the order + a usage ledger ───────
-- Enforces per_customer_usage_limit and answers "which orders used coupon X".
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "promotion_id" uuid;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "promotion"("id") ON DELETE set null;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "promotion_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id"),
  "promotion_id" uuid NOT NULL REFERENCES "promotion"("id"),
  "customer_id" uuid REFERENCES "customer"("id"),
  "order_id" uuid NOT NULL REFERENCES "order"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "promotion_usage_promo_order" UNIQUE ("promotion_id", "order_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_usage_promo_customer_idx" ON "promotion_usage" ("promotion_id", "customer_id");--> statement-breakpoint
ALTER TABLE "promotion_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "promotion_usage" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

-- ── 2) Saved payment methods (gateway vault refs) — enables Stripe/PayPal ────
CREATE TABLE IF NOT EXISTS "payment_method" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customer"("id"),
  "gateway" text NOT NULL,                 -- stripe | paypal | nmi | sezzle
  "provider_customer_ref" text,            -- e.g. Stripe customer id / PayPal payer id
  "provider_method_ref" text,              -- token / payment_method id (NEVER a PAN)
  "brand" text, "last4" text, "exp_month" integer, "exp_year" integer,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_method_customer_idx" ON "payment_method" ("customer_id");--> statement-breakpoint
ALTER TABLE "payment_method" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_method" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_method" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

-- ── 3) Link tables: add store_id + RLS (was parent-FK isolation only) ────────
-- The backfill joins to the parent tables, which have FORCE RLS — so even the
-- owner sees zero parent rows without a store context. Temporarily lift FORCE on
-- the parents for the duration of this migration (it holds an ACCESS EXCLUSIVE
-- lock, so concurrent requests block rather than see un-forced data), then
-- restore FORCE at the end.
ALTER TABLE "product_variant" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fulfillment" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Backfill store_id from each table's parent, then NOT NULL + FORCE RLS.
ALTER TABLE "variant_option" ADD COLUMN IF NOT EXISTS "store_id" uuid;--> statement-breakpoint
UPDATE "variant_option" vo SET "store_id" = pv."store_id" FROM "product_variant" pv WHERE pv."id" = vo."variant_id" AND vo."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "variant_option" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variant_option" ADD CONSTRAINT "variant_option_store_fk" FOREIGN KEY ("store_id") REFERENCES "store"("id");--> statement-breakpoint
ALTER TABLE "variant_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "variant_option" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "variant_option" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "collection_product" ADD COLUMN IF NOT EXISTS "store_id" uuid;--> statement-breakpoint
UPDATE "collection_product" cp SET "store_id" = c."store_id" FROM "collection" c WHERE c."id" = cp."collection_id" AND cp."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "collection_product" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_product" ADD CONSTRAINT "collection_product_store_fk" FOREIGN KEY ("store_id") REFERENCES "store"("id");--> statement-breakpoint
ALTER TABLE "collection_product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection_product" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "collection_product" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "product_asset" ADD COLUMN IF NOT EXISTS "store_id" uuid;--> statement-breakpoint
UPDATE "product_asset" pa SET "store_id" = p."store_id" FROM "product" p WHERE p."id" = pa."product_id" AND pa."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "product_asset" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_asset" ADD CONSTRAINT "product_asset_store_fk" FOREIGN KEY ("store_id") REFERENCES "store"("id");--> statement-breakpoint
ALTER TABLE "product_asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product_asset" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "variant_asset" ADD COLUMN IF NOT EXISTS "store_id" uuid;--> statement-breakpoint
UPDATE "variant_asset" va SET "store_id" = pv."store_id" FROM "product_variant" pv WHERE pv."id" = va."variant_id" AND va."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "variant_asset" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variant_asset" ADD CONSTRAINT "variant_asset_store_fk" FOREIGN KEY ("store_id") REFERENCES "store"("id");--> statement-breakpoint
ALTER TABLE "variant_asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "variant_asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "variant_asset" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

-- fulfillment_line / refund_line are currently empty (no writers yet); add the
-- column + RLS now so future writes are isolated.
ALTER TABLE "fulfillment_line" ADD COLUMN IF NOT EXISTS "store_id" uuid;--> statement-breakpoint
UPDATE "fulfillment_line" fl SET "store_id" = f."store_id" FROM "fulfillment" f WHERE f."id" = fl."fulfillment_id" AND fl."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "fulfillment_line" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfillment_line" ADD CONSTRAINT "fulfillment_line_store_fk" FOREIGN KEY ("store_id") REFERENCES "store"("id");--> statement-breakpoint
ALTER TABLE "fulfillment_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fulfillment_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fulfillment_line" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "refund_line" ADD COLUMN IF NOT EXISTS "store_id" uuid;--> statement-breakpoint
UPDATE "refund_line" rl SET "store_id" = r."store_id" FROM "refund" r WHERE r."id" = rl."refund_id" AND rl."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "refund_line" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_store_fk" FOREIGN KEY ("store_id") REFERENCES "store"("id");--> statement-breakpoint
ALTER TABLE "refund_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "refund_line" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

-- Restore FORCE on the parent tables now that backfills are done.
ALTER TABLE "product_variant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fulfillment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── 4) Tighten loose FKs (were bare uuids). NOT VALID so legacy rows don't ───
-- block the migration; the constraint still enforces all NEW writes.
ALTER TABLE "collection" ADD CONSTRAINT "collection_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "collection"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_ref_order_fk" FOREIGN KEY ("ref_order_id") REFERENCES "order"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") NOT VALID;
