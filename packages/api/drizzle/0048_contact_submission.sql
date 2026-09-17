-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- PAR-01: durable record for the public contact form. Mirrors the
-- confirm-before-deliver semantics of the legacy Vendure contact-form plugin
-- (damned/rotten): the submitter gets a SIGNED confirmation link; only the
-- first valid click delivers the message to the store's team inbox and sends
-- the customer an acknowledgment.
--
-- Why a table (the legacy plugin carried the whole submission in the HMAC-
-- signed URL and deduped clicks in Redis): persisting the row at submit time
-- makes duplicate-click suppression an atomic `UPDATE … WHERE status='pending'
-- RETURNING` claim instead of a cache SET NX, keeps the emailed link short
-- (id + ts + sig, not a base64 blob of the whole message), and leaves an
-- auditable record of what was submitted even if the link is never clicked.
--
-- `status`: 'pending' = submitted, awaiting the submitter's email confirm;
-- 'delivered' = link clicked once, team + ack emails enqueued. The
-- pending→delivered transition is the dedupe primitive — concurrent or
-- repeated clicks can only win once. Link expiry (24h) is enforced at read
-- time on the `ts` claim, matching the subscriber token model where the row
-- outlives the link.
--
-- There is intentionally NO capability `token` column: the link's authority
-- is the HMAC signature over (id, ts) — see src/routes/contact.ts.

CREATE TABLE "contact_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"remote_ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_submission" ADD CONSTRAINT "contact_submission_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Mailbomb-guard lookup: a repeat POST for the same address inside the
-- cooldown window must find the recent row cheaply (see contact.ts — the
-- guard suppresses the confirmation email, never the response shape).
CREATE INDEX "contact_submission_email_idx" ON "contact_submission" ("store_id", "email", "created_at");--> statement-breakpoint
-- Admin/ops listing per store.
CREATE INDEX "contact_submission_status_idx" ON "contact_submission" ("store_id", "status", "created_at");--> statement-breakpoint
ALTER TABLE "contact_submission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_submission" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_submission" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint
-- DOWN
-- DROP INDEX "contact_submission_status_idx";
-- DROP INDEX "contact_submission_email_idx";
-- DROP POLICY "tenant_isolation" ON "contact_submission";
-- DROP TABLE "contact_submission";
