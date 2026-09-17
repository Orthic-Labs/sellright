-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- PAR-04: SheerID verification lifecycle. The imported Vendure custom fields on
-- `customer` (sheerid_verifications jsonb / active_verifications text[] /
-- verification_metadata jsonb) remain the coupon-eligibility read model — the
-- verified_customer promotion condition (money/coupon.ts) checks
-- active_verifications. This table adds the missing durable LIFECYCLE record:
-- one row per SheerID verification attempt, pending → success|failed, then
-- expired|revoked. The service (src/sheerid/) recomputes the customer jsonb
-- fields from rows here, so expiry and revocation flip coupon eligibility
-- without touching checkout code.
--
-- verification_id is SheerID's id, known only after the hosted flow calls our
-- webhook — NULL while the attempt is still pending on our side. The partial
-- unique index dedupes webhook redelivery (SheerID retries) without blocking
-- repeat pending attempts that have no provider id yet.

CREATE TABLE "sheerid_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid,
	"verification_id" text,
	"program_id" text NOT NULL,
	"category" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"discount_percent" integer,
	"expires_at" timestamp with time zone,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sheerid_verification_status_check" CHECK ("status" IN ('pending','success','failed','revoked','expired'))
);
--> statement-breakpoint
ALTER TABLE "sheerid_verification" ADD CONSTRAINT "sheerid_verification_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheerid_verification" ADD CONSTRAINT "sheerid_verification_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Webhook idempotency: one durable record per SheerID verification id.
CREATE UNIQUE INDEX "sheerid_verification_vid_key" ON "sheerid_verification" ("store_id", "verification_id") WHERE "verification_id" IS NOT NULL;--> statement-breakpoint
-- Sweep query: success rows past expiry, and pending rows for a customer.
CREATE INDEX "sheerid_verification_customer_idx" ON "sheerid_verification" ("store_id", "customer_id", "status");--> statement-breakpoint
CREATE INDEX "sheerid_verification_expiry_idx" ON "sheerid_verification" ("status", "expires_at") WHERE "expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sheerid_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sheerid_verification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sheerid_verification" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
-- DOWN
-- DROP INDEX "sheerid_verification_expiry_idx";
-- DROP INDEX "sheerid_verification_customer_idx";
-- DROP INDEX "sheerid_verification_vid_key";
-- DROP POLICY "tenant_isolation" ON "sheerid_verification";
-- DROP TABLE "sheerid_verification";
