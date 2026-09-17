-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- PAR-07: chargeback/dispute record + operator alert. Stripe disputes were
-- previously recorded only as audit_log rows (payments/webhook-reconcile.ts),
-- and NMI chargebacks had no ingestion at all. This table is the canonical
-- per-store dispute ledger for BOTH providers: dedupe on
-- (store_id, provider, provider_ref) so provider webhook retries never double-
-- notify, and `notified_at` marks that the operator email was enqueued to the
-- email_outbox (0038) in the same transaction as the row insert.
--
-- Deliberately does NOT auto-refund or auto-cancel: dispute handling stays a
-- human decision (same stance as recordStripeDispute). `details` carries the
-- provider payload excerpt for operator review.

CREATE TABLE "dispute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"payment_id" uuid,
	"order_id" uuid,
	"amount" integer,
	"currency" text,
	"reason" text,
	"status" text DEFAULT 'open' NOT NULL,
	"details" jsonb,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Idempotency: provider dispute/chargeback ids are unique per store. A retry
-- of the same provider event hits this and no-ops (no second operator email).
CREATE UNIQUE INDEX "dispute_provider_ref_key" ON "dispute" ("store_id", "provider", "provider_ref");--> statement-breakpoint
CREATE INDEX "dispute_order_idx" ON "dispute" ("store_id", "order_id");--> statement-breakpoint
ALTER TABLE "dispute" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispute" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dispute" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
-- DOWN
-- DROP INDEX "dispute_order_idx";
-- DROP INDEX "dispute_provider_ref_key";
-- DROP POLICY "tenant_isolation" ON "dispute";
-- DROP TABLE "dispute";
