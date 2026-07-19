-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- SUBSCRIBER-1 (docs/plans/2026-07-19-subscriber-newsletter-waitlist.md): the
-- `subscriber` table becomes the source of truth for newsletter + waitlist
-- signups. The previous inline-Listmonk path silently dropped addresses on any
-- failure (see plan "Why this exists" §1). This table is the durable record;
-- Listmonk is demoted to a best-effort downstream sync target pushed by the
-- listmonk-sync job, the same outbox pattern email_outbox (0038) and
-- webhook_delivery (0031) use for outbound work.
--
-- One table serves both newsletter and waitlist, discriminated by `kind` +
-- `topic`. A waitlist is a newsletter whose list happens to be named after an
-- unreleased product; modelling them separately would duplicate confirmation,
-- unsubscribe, rate limiting, and admin export twice.
--
-- `topic` is NOT NULL DEFAULT '' specifically so the (store_id, email, kind,
-- topic) UNIQUE works. Postgres treats NULLs as distinct in unique
-- constraints, so a nullable `topic` would allow unlimited duplicate
-- general-newsletter rows for the same address. Do not "clean this up" to a
-- nullable column.
--
-- `token` is the capability URL for confirm + one-click unsubscribe. 122 bits
-- of randomness from gen_random_uuid(); never derived from the email.
--
-- `last_sent_at` is the mailbomb guard: at most one confirmation email per
-- address per hour, checked inside the signup transaction. The per-IP
-- `newsletterRetryAfter` throttle stays as the first gate.

CREATE TABLE "subscriber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"kind" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"source" text,
	"meta" jsonb,
	"listmonk_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriber" ADD CONSTRAINT "subscriber_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One row per person per list. `topic` is NOT NULL DEFAULT '' so the empty
-- topic for the general newsletter is a real value (Postgres treats NULL as
-- distinct in unique constraints — see file header).
CREATE UNIQUE INDEX "subscriber_store_email_kind_topic_key" ON "subscriber" ("store_id", "email", "kind", "topic");--> statement-breakpoint
-- Lookup key for confirm + unsubscribe capability URLs.
CREATE UNIQUE INDEX "subscriber_token_key" ON "subscriber" ("token");--> statement-breakpoint
-- Admin list / count queries (per-app waitlist number, etc.).
CREATE INDEX "subscriber_list_idx" ON "subscriber" ("store_id", "kind", "topic", "status");--> statement-breakpoint
-- Sync job claim query: `status='confirmed' AND listmonk_synced_at IS NULL`.
CREATE INDEX "subscriber_sync_idx" ON "subscriber" ("status", "listmonk_synced_at");--> statement-breakpoint
ALTER TABLE "subscriber" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriber" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscriber" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint
-- DOWN
-- DROP INDEX "subscriber_sync_idx";
-- DROP INDEX "subscriber_list_idx";
-- DROP INDEX "subscriber_token_key";
-- DROP INDEX "subscriber_store_email_kind_topic_key";
-- DROP POLICY "tenant_isolation" ON "subscriber";
-- DROP TABLE "subscriber";
