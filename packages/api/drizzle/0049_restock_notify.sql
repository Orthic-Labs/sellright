-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- PAR-05: back-in-stock automation. Two tables + a trigger:
--
--   restock_request — a shopper's "notify me" signup for one variant.
--     `status` pending → notified is the once-per-restock dedupe primitive:
--     the notifier claims rows atomically (`UPDATE … WHERE status='pending'
--     RETURNING`), so concurrent restock paths cannot double-send. 'canceled'
--     is the consent state — reached via the per-row `token` cancel link in
--     the notification email, or never emailed at all. A notified/canceled
--     row does NOT block re-signup: the pending-only partial unique index
--     lets the same address subscribe again for a later restock cycle while
--     still deduping double-submits of the live request.
--
--   restock_event — the durable 0→>0 availability transition queue, written
--     by the stock trigger below. Every stock write path in this codebase
--     (admin PATCH /variants/:id/stock, admin-catalog location-stock upsert
--     and variant create, the release-stale-allocations job, returns
--     restock, catalog import) funnels through INSERT/UPDATE on `stock`, so
--     a trigger catches transitions without each writer needing to remember
--     to call the notifier. src/routes/restock.ts::sweepRestockEvents drains
--     the queue (scheduler wiring) and notifyRestock() is the direct-call
--     API for call sites that want immediate notification.
--
-- The partial unique index on restock_event collapses a burst of stock
-- writes for one variant into a single pending event — the claim side
-- already dedupes per subscriber, so duplicate events would be harmless,
-- but the index keeps the queue small under bulk imports.

CREATE TABLE "restock_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"email" text NOT NULL,
	-- Denormalized at signup for the notification email + admin readability
	-- (the product may be renamed or deleted before the restock lands).
	"product_name" text NOT NULL,
	"variant_name" text NOT NULL,
	"product_slug" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	-- Cancel capability for the "don't notify me" link in the email.
	-- 122 bits from gen_random_uuid(); never derived from the email.
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restock_request" ADD CONSTRAINT "restock_request_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_request" ADD CONSTRAINT "restock_request_variant_id_product_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One live request per (store, variant, email). Partial on purpose: a
-- notified or canceled row must not block the same address re-subscribing
-- for the NEXT restock cycle.
CREATE UNIQUE INDEX "restock_request_pending_key" ON "restock_request" ("store_id", "variant_id", "email") WHERE "status" = 'pending';--> statement-breakpoint
-- Lookup key for the cancel capability URL.
CREATE UNIQUE INDEX "restock_request_token_key" ON "restock_request" ("token");--> statement-breakpoint
-- Claim query for the notifier: pending rows for a restocked variant.
CREATE INDEX "restock_request_claim_idx" ON "restock_request" ("variant_id", "status");--> statement-breakpoint
ALTER TABLE "restock_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "restock_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restock_request" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

CREATE TABLE "restock_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "restock_event" ADD CONSTRAINT "restock_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One unprocessed event per variant at a time — see file header.
CREATE UNIQUE INDEX "restock_event_pending_variant_key" ON "restock_event" ("variant_id") WHERE "processed_at" IS NULL;--> statement-breakpoint
-- Sweep claim query.
CREATE INDEX "restock_event_pending_idx" ON "restock_event" ("store_id", "created_at") WHERE "processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "restock_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "restock_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restock_event" USING ("store_id" = current_setting('app.current_store', true)::uuid) WITH CHECK ("store_id" = current_setting('app.current_store', true)::uuid);--> statement-breakpoint

-- Fires on any stock write that takes a variant from not-available to
-- available (on_hand - allocated crossing 0 → >0). An INSERT counts as a
-- transition too: a variant with no stock row was effectively unavailable.
-- The event insert shares the writer's transaction, so a rolled-back stock
-- change never leaves a phantom event; under the app role the row's own
-- store_id satisfies restock_event's tenant_isolation WITH CHECK.
CREATE OR REPLACE FUNCTION stock_restock_event() RETURNS trigger AS $$
DECLARE
	old_available int;
BEGIN
	old_available := CASE WHEN TG_OP = 'UPDATE'
		THEN coalesce(OLD.on_hand, 0) - coalesce(OLD.allocated, 0)
		ELSE 0 END;
	IF (coalesce(NEW.on_hand, 0) - coalesce(NEW.allocated, 0)) > 0 AND old_available <= 0 THEN
		INSERT INTO restock_event (store_id, variant_id)
		VALUES (NEW.store_id, NEW.variant_id)
		ON CONFLICT (variant_id) WHERE processed_at IS NULL DO NOTHING;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "stock_restock_event_trg" AFTER INSERT OR UPDATE OF "on_hand", "allocated" ON "stock" FOR EACH ROW EXECUTE FUNCTION stock_restock_event();--> statement-breakpoint
-- DOWN
-- DROP TRIGGER "stock_restock_event_trg" ON "stock";
-- DROP FUNCTION stock_restock_event();
-- DROP INDEX "restock_event_pending_idx";
-- DROP INDEX "restock_event_pending_variant_key";
-- DROP POLICY "tenant_isolation" ON "restock_event";
-- DROP TABLE "restock_event";
-- DROP INDEX "restock_request_claim_idx";
-- DROP INDEX "restock_request_token_key";
-- DROP INDEX "restock_request_pending_key";
-- DROP POLICY "tenant_isolation" ON "restock_request";
-- DROP TABLE "restock_request";
