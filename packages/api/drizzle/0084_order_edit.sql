-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Same stale-snapshot drift reason as 0072-0083: drizzle-kit would re-emit
-- CREATE TABLE for already-live tables, so this carries ONLY the additive
-- order-editing changes (spec G13/G5): the `order_adjustment` ledger (a +/-
-- labelled amount applied to an order total), the `order_edit` history
-- (before/after snapshot + balance + settlement per committed edit, keyed by
-- the commit idempotency key), and `order.shipping_override`.
--
-- Expand-only: new tables + one defaulted column, so the previous release's
-- INSERTs keep working unmodified. Both new tables cascade with the order
-- (the bulk-purge path deletes the order row and must not be blocked by them).
-- Tenant isolation: ENABLE + FORCE RLS with the standard tenant_isolation
-- policy (privileges come from the schema's default privileges for
-- sellright_app, as for every other tenant table).
CREATE TABLE IF NOT EXISTS "order_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount" integer NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_adjustment" ADD CONSTRAINT "order_adjustment_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustment" ADD CONSTRAINT "order_adjustment_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_adjustment_order_idx" ON "order_adjustment" USING btree ("order_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"idempotency_key" text,
	"fingerprint" text,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"settlement" jsonb,
	"reason" text,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_edit" ADD CONSTRAINT "order_edit_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_edit" ADD CONSTRAINT "order_edit_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_edit_order_idx" ON "order_edit" USING btree ("order_id", "created_at");--> statement-breakpoint
-- A commit is idempotent per (store, key): a replay returns the stored result.
CREATE UNIQUE INDEX IF NOT EXISTS "order_edit_idempotency_uidx" ON "order_edit" USING btree ("store_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "shipping_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_adjustment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_adjustment" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "order_edit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_edit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_edit" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
-- DOWN
-- ALTER TABLE "order" DROP COLUMN "shipping_override";
-- DROP TABLE "order_edit";
-- DROP TABLE "order_adjustment";
