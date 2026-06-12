-- Software/digital fulfillment for Right Apps-style stores.
-- Additive: existing physical commerce defaults to fulfillment_type='physical'.
DO $$ BEGIN
  CREATE TYPE "public"."fulfillment_type" AS ENUM('physical', 'digital_download', 'license', 'update_pass');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."license_status" AS ENUM('active', 'revoked', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "fulfillment_type" "fulfillment_type" DEFAULT 'physical' NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "app_key" text;
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "artifact_key" text;
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "license_seats" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "license_duration_days" integer;
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "updates_duration_days" integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "license" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "customer_id" uuid,
  "order_id" uuid NOT NULL,
  "order_line_id" uuid NOT NULL,
  "app_key" text NOT NULL,
  "license_key" text NOT NULL,
  "status" "license_status" DEFAULT 'active' NOT NULL,
  "seats" integer DEFAULT 1 NOT NULL,
  "updates_until" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "license_license_key_unique" UNIQUE("license_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "license_activation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "license_id" uuid NOT NULL,
  "app_key" text NOT NULL,
  "device_id_hash" text NOT NULL,
  "activation_token_hash" text,
  "device_label" text,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "license_activation_device" UNIQUE("license_id","device_id_hash")
);
--> statement-breakpoint
ALTER TABLE "license_activation" ADD COLUMN IF NOT EXISTS "activation_token_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "license_activation_token_hash_unique" ON "license_activation" ("activation_token_hash") WHERE "activation_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_release" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "app_key" text NOT NULL,
  "version" text NOT NULL,
  "channel" text DEFAULT 'stable' NOT NULL,
  "platform" text,
  "manifest" jsonb NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_release_unique" UNIQUE("store_id","app_key","channel","platform","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "download_artifact" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "app_release_id" uuid NOT NULL,
  "artifact_key" text NOT NULL,
  "path" text NOT NULL,
  "sha256" text,
  "size_bytes" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "download_artifact_key" UNIQUE("store_id","artifact_key")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license" ADD CONSTRAINT "license_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license" ADD CONSTRAINT "license_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license" ADD CONSTRAINT "license_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license" ADD CONSTRAINT "license_order_line_id_order_line_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license_activation" ADD CONSTRAINT "license_activation_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "license_activation" ADD CONSTRAINT "license_activation_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_release" ADD CONSTRAINT "app_release_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "download_artifact" ADD CONSTRAINT "download_artifact_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "download_artifact" ADD CONSTRAINT "download_artifact_app_release_id_app_release_id_fk" FOREIGN KEY ("app_release_id") REFERENCES "public"."app_release"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "license_store_app_key_idx" ON "license" ("store_id","app_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_release_store_app_channel_idx" ON "app_release" ("store_id","app_key","channel","published_at");
--> statement-breakpoint
ALTER TABLE "license" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "license";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "license_activation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license_activation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "license_activation";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license_activation" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "app_release" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_release" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "app_release";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app_release" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "download_artifact" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "download_artifact" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "download_artifact";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "download_artifact" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
