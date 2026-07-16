-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Mobile push (APNs) for the admin iOS app. Two tables:
--
-- 1. admin_device_token — one row per (admin, device). The APNs device token is
--    the address we push to. Scoped to BOTH admin_user and store: an operator
--    with access to two stores registers once per store they want alerts for, so
--    revoking their access to one store stops those pushes without touching the
--    other. store_id also lets the tenant_isolation policy work like every other
--    table here (the app role never sees another tenant's tokens).
--
--    A device token is not a secret in the credential sense — it addresses a
--    device, it doesn't authenticate one — but it IS personal data (it links a
--    human to a physical device), so it lives under RLS like everything else and
--    is deleted on logout, on 410 Unregistered from APNs, and on admin deletion.
--
--    ON CONFLICT (token) DO UPDATE: iOS reissues the same token to the same app,
--    and a device can be handed to a different operator. The token is therefore
--    the natural key — re-registering rebinds it to whoever is signed in now,
--    which is exactly what we want (the previous owner must stop getting pushes).
--
-- 2. push_outbox — transactional outbox, same shape and lifecycle as
--    email_outbox (0038) and webhook_delivery (0031). Enqueued in the SAME txn
--    as the order transition that caused it, so a rolled-back order never pushes
--    a "new order!" alert, and an APNs outage retries instead of silently
--    dropping the alert. No network call at the call site — the codebase already
--    learned this twice (REL-4 emails, and gateway-out-of-txn for refunds).
--
--    Status state machine: pending → processing → (sent | dead), backoff
--    1m/5m/30m/2h/12h then dead. Deliberately SHORTER retry semantics than email
--    in spirit: a 12h-late "new order" ding is useless, but the dead row is still
--    the ops record that the push never landed.

-- `kind` distinguishes the two token types a device registers, which are NOT
-- interchangeable and fail confusingly if swapped:
--   'apns'          — the plain device token; addresses alert pushes.
--   'live_activity' — the push-to-start token (iOS 17.2+); authorizes STARTING a
--                     Live Activity on a device where the app isn't running. It
--                     goes to a different apns-topic (…​.push-type.liveactivity)
--                     with apns-push-type: liveactivity.
-- One device therefore has up to two rows. `token` stays globally unique — the
-- two token values are distinct — so the rebind-on-conflict logic is unchanged.
CREATE TABLE "admin_device_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"kind" text DEFAULT 'apns' NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"topics" text[] DEFAULT '{"order.paid"}' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"device_token" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
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
ALTER TABLE "admin_device_token" ADD CONSTRAINT "admin_device_token_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ON DELETE cascade on the admin: deleting an operator must not leave their
-- device receiving this store's order alerts.
ALTER TABLE "admin_device_token" ADD CONSTRAINT "admin_device_token_admin_user_id_admin_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One row per physical device: re-registering rebinds the token to the current
-- admin/store rather than accumulating stale rows that push to the same phone.
CREATE UNIQUE INDEX "admin_device_token_token_key" ON "admin_device_token" ("token");--> statement-breakpoint
CREATE INDEX "admin_device_token_store_idx" ON "admin_device_token" ("store_id");--> statement-breakpoint
ALTER TABLE "push_outbox" ADD CONSTRAINT "push_outbox_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "admin_device_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_device_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "admin_device_token" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint
ALTER TABLE "push_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "push_outbox" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint
-- Scheduler claim path, mirroring email_outbox_due_idx (0038): the sender runs as
-- OWNER with no current_store set and claims across stores.
CREATE INDEX "push_outbox_due_idx" ON "push_outbox" ("status", "next_attempt_at");
-- DOWN
-- DROP INDEX "push_outbox_due_idx";
-- DROP POLICY "tenant_isolation" ON "push_outbox";
-- DROP POLICY "tenant_isolation" ON "admin_device_token";
-- DROP TABLE "push_outbox";
-- DROP TABLE "admin_device_token";
