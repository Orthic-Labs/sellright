-- HAND-WRITTEN: see docs/runbooks/migrations.md
--
-- 0066_storekit — Apple StoreKit (App Store Server / JWS) purchase
-- verification, ported upstream from RightSites and genericized for
-- multi-store:
--
--   * license.order_id / license.order_line_id become nullable: a StoreKit
--     purchase has no SellRight order behind it (Apple is the merchant of
--     record), so the license row is minted without one.
--   * license.source tags the provenance ('order' | 'storekit').
--   * storekit_app is the per-(store, app) configuration: bundle id, App
--     Store Connect id, product→entitlement map, sandbox policy. Every
--     deployment-specific verification fact lives here — never in client
--     input.
--   * storekit_purchase is the durable (environment, originalTransactionId)
--     → license binding, replay-safe for both the link endpoint and App
--     Store Server Notifications.
--
-- Rollback: DROP TABLE storekit_purchase, storekit_app; restore the license
-- NOT NULLs (only safe while no source='storekit' rows exist).

ALTER TABLE "license" ALTER COLUMN "order_id" DROP NOT NULL;
ALTER TABLE "license" ALTER COLUMN "order_line_id" DROP NOT NULL;

-- Deliberately NOT a CHECK constraint: sibling licensing work lands other
-- provenance values ('admin', future import sources) on the same column.
ALTER TABLE "license" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'order';

CREATE TABLE IF NOT EXISTS "storekit_app" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id"),
  "app_key" text NOT NULL,
  "bundle_id" text NOT NULL,
  -- NULL = Production verification disabled (sandbox/TestFlight-only app).
  "app_apple_id" bigint,
  "allow_sandbox" boolean NOT NULL DEFAULT true,
  "product_map" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "storekit_app_store_app" UNIQUE ("store_id", "app_key"),
  CONSTRAINT "storekit_app_bundle_id" UNIQUE ("bundle_id")
);

CREATE TABLE IF NOT EXISTS "storekit_purchase" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id"),
  "storekit_app_id" uuid REFERENCES "storekit_app"("id"),
  "license_id" uuid REFERENCES "license"("id"),
  "app_key" text NOT NULL,
  "environment" text NOT NULL,
  "bundle_id" text NOT NULL,
  "product_id" text NOT NULL,
  "original_transaction_id" text NOT NULL,
  "transaction_id" text,
  "customer_id" uuid REFERENCES "customer"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "expires_at" timestamp with time zone,
  "purchase_date" timestamp with time zone,
  "revocation_date" timestamp with time zone,
  "last_notification_type" text,
  "last_notification_uuid" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "storekit_purchase_unique" UNIQUE ("store_id", "environment", "original_transaction_id")
);

CREATE INDEX IF NOT EXISTS "storekit_purchase_license_idx"
  ON "storekit_purchase" ("license_id");
CREATE INDEX IF NOT EXISTS "storekit_purchase_store_app_idx"
  ON "storekit_purchase" ("store_id", "app_key");

ALTER TABLE "storekit_app" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storekit_app" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "storekit_app";
CREATE POLICY "tenant_isolation" ON "storekit_app"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

ALTER TABLE "storekit_purchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storekit_purchase" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "storekit_purchase";
CREATE POLICY "tenant_isolation" ON "storekit_purchase"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

-- Pre-context tenant resolution for inbound App Store Server Notifications,
-- mirroring 0053's resolve_store_for_gateway_event: the webhook arrives with
-- no app.current_store and connects as the RLS nonowner role, so a scoped
-- query fails closed. The signed bundle id inside Apple's payload is the
-- tenant selector; this SECURITY DEFINER function (owned by the migration
-- role, which must be superuser/BYPASSRLS) returns ONLY a store_id — the
-- config row itself stays behind FORCE RLS and is re-read inside withStore.
--
-- EXECUTE stays at the PUBLIC default (the runtime app role must call it).
-- The result is an existence oracle over bundle ids — a caller must already
-- know the exact bundle_id to learn anything.
CREATE OR REPLACE FUNCTION public.resolve_store_for_storekit_bundle(p_bundle_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT sa.store_id FROM public.storekit_app AS sa
   WHERE sa.bundle_id = p_bundle_id
   LIMIT 1;
$fn$;
