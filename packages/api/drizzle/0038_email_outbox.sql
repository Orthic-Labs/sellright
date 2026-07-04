-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- REL-4 (DISPATCH.md): the order-confirmation email was fire-and-forget (best-effort
-- in dispatch.ts) — a transient SMTP outage silently dropped the confirmation and the
-- customer had no idea they paid. This migration adds an outbox table so the email is
-- enqueued in the same transaction as the Paid transition and pushed by the scheduler
-- with retry + dead-letter, mirroring the webhook_outbox pattern (0031 / webhook_delivery).
--
-- Why a separate table (not webhook_delivery): emails are addressed to a recipient, not
-- to a subscribed endpoint with HMAC; the schema is different enough that reusing the
-- webhook table would force ugly columns-to-NULL. A clean table is the right move.
--
-- Status state machine: pending → processing → (sent | dead). The scheduler claims a
-- batch under FOR UPDATE SKIP LOCKED, flips pending→processing, attempts delivery, and
-- either marks sent (success) or — on failure — flips back to pending with a bumped
-- next_attempt_at (exponential backoff: 1m, 5m, 30m, 2h, 12h). After 5 failed attempts
-- the row goes to 'dead' for ops review (an `email_outbox_dead` query picks them up).
--
-- payload carries the full sendEmail input (to, subject, html, text, from?) so the
-- scheduler never has to re-derive any rendering — a re-render on retry would risk
-- drift between the order-snapshot and what the customer finally sees.

CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_outbox" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint
-- Scheduler claim path: the only access outside the per-store txn. The scheduler runs
-- as OWNER with no current_store set, so this policy lets the owner touch rows across
-- stores — analogous to the webhook delivery claim. Match webhook_delivery's index
-- shape (status + next_attempt_at) so the planner behaves consistently.
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" ("status", "next_attempt_at");
-- DOWN
-- DROP INDEX "email_outbox_due_idx";
-- DROP POLICY "tenant_isolation" ON "email_outbox";
-- DROP TABLE "email_outbox";