-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Drizzle's auto-generator emits a different snapshot for the subscription
-- table than what's in this file (it lacks the FORCE RLS + tenant_isolation
-- policy at the right ordinal, and would emit the ENUM on a different line).
-- Regenerating produces a migration that fails to apply on a fresh DB.
CREATE TYPE "public"."subscription_status" AS ENUM('incomplete', 'active', 'past_due', 'canceled');--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "billing_interval" text;--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_id" uuid,
	"license_id" uuid,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text,
	"price_id" text,
	"status" "subscription_status" DEFAULT 'incomplete' NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);
-- DOWN
-- DROP POLICY "tenant_isolation" ON "subscription";
-- DROP TABLE "subscription";
-- DROP TYPE "subscription_status";
-- ALTER TABLE "product_variant" DROP COLUMN "stripe_price_id", DROP COLUMN "billing_interval";
