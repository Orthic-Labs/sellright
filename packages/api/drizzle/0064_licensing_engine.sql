-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- Migration 0064: generic licensing-engine delta.
--
--   license           — orderless issuance support: nullable order refs, a
--                       `source` discriminator ('order' default; 'admin' for
--                       minted comp/support/creator licenses — a 'storekit'
--                       value is reserved for a later suite migration), and
--                       explicit provenance columns (issued_by, issue_reason)
--                       required by mintLicense. License keys become unique
--                       per (app_key, license_key) instead of globally.
--   license_activation — server-derived device accounting: class/pool,
--                       renewable lease fields (lease_id/issued/expires/grace),
--                       tombstone state + generation for revoke/remove replay
--                       safety, and canonical entitlement-issuance markers.
--   runtime_artifact_promotion — current signed runtime/model artifact
--                       registration (one row per app/kind/os/arch).
--
-- Idempotent so an interrupted/re-applied rollout is safe.
-- RLS: license / license_activation already have FORCE RLS + tenant_isolation
-- from 0027; runtime_artifact_promotion gets the same treatment here.

-- ── license ─────────────────────────────────────────────────────────────────
ALTER TABLE "license" ALTER COLUMN "order_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "license" ALTER COLUMN "order_line_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "license" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'order';
--> statement-breakpoint
ALTER TABLE "license" ADD COLUMN IF NOT EXISTS "issued_by" text;
--> statement-breakpoint
ALTER TABLE "license" ADD COLUMN IF NOT EXISTS "issue_reason" text;
--> statement-breakpoint
ALTER TABLE "license" DROP CONSTRAINT IF EXISTS "license_license_key_unique";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license" ADD CONSTRAINT "license_app_key_unique" UNIQUE("app_key","license_key");
EXCEPTION WHEN duplicate_table THEN null; WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- ── license_activation ─────────────────────────────────────────────────────
-- Nullable on purpose: existing rows and apps without a registered device
-- policy stay unclassified rather than backfilled with a guess.
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "device_class" text;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "platform" text;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "pool" text;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license_activation" ADD CONSTRAINT "license_activation_state_check"
    CHECK ("state" IN ('active', 'removed', 'revoked'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "removed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "lease_id" uuid;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "lease_issued_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "lease_grace_seconds" integer;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
-- Canonical signed-entitlement issuance inventory: NULL means legacy or
-- unknown and remains blocking until a device receives a canonical token or
-- deactivates.
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "entitlement_token_version" integer;
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "entitlement_token_issued_at" timestamptz;
--> statement-breakpoint
-- Speeds the per-license, per-pool aggregate the lease issuer runs under
-- FOR UPDATE before admitting a new device, filtered to state='active'.
CREATE INDEX IF NOT EXISTS "license_activation_license_pool_state_idx"
  ON "license_activation" ("license_id", "pool", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "license_activation_license_class_idx"
  ON "license_activation" ("license_id", "device_class");
--> statement-breakpoint

-- ── runtime_artifact_promotion ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "runtime_artifact_promotion" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "app_key" text NOT NULL,
  "artifact_kind" text NOT NULL,
  "target_os" text NOT NULL,
  "target_arch" text NOT NULL,
  "delivery" text NOT NULL,
  "pointer_key" text,
  "object_sha256" text NOT NULL,
  "envelope_sha256" text NOT NULL,
  "signing_key_id" text NOT NULL,
  "promotion_id" text NOT NULL,
  "envelope" jsonb NOT NULL,
  "promoted_at" timestamp with time zone NOT NULL,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runtime_artifact_promotion_current" UNIQUE("store_id", "app_key", "artifact_kind", "target_os", "target_arch"),
  CONSTRAINT "runtime_artifact_promotion_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "runtime_artifact_promotion" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "runtime_artifact_promotion" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "tenant_isolation" ON "runtime_artifact_promotion"
    USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
    WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- DOWN
-- DROP POLICY "tenant_isolation" ON "runtime_artifact_promotion";
-- DROP TABLE "runtime_artifact_promotion";
-- DROP INDEX "license_activation_license_class_idx";
-- DROP INDEX "license_activation_license_pool_state_idx";
-- ALTER TABLE "license_activation" DROP COLUMN "entitlement_token_issued_at", ... (all added columns);
-- ALTER TABLE "license" DROP CONSTRAINT "license_app_key_unique";
-- ALTER TABLE "license" DROP COLUMN "issue_reason", "issued_by", "source";
