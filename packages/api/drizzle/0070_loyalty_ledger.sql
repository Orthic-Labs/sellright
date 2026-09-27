-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- LOYALTY-1: points & rewards. One append-only ledger per store; a customer's
-- balance is ALWAYS the sum of their ledger rows — there is no mutable
-- balance counter anywhere. Program settings live in store.config.loyalty
-- (same JSONB blob as every other per-store setting), so this migration adds
-- exactly one table.
--
-- Hand-written because drizzle-kit cannot express: the partial unique index
-- on source_ref (idempotency key for earn/redeem/reversal/import postings),
-- the per-kind sign CHECK, or the BEFORE UPDATE trigger that makes the table
-- append-only. DELETE stays possible on purpose: GDPR account erasure and the
-- importer's verified restore remove a customer's/tenant's rows wholesale.
-- Additive only — no existing table is touched.

CREATE TABLE IF NOT EXISTS "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"order_id" uuid,
	"refund_id" uuid,
	"source_ref" text,
	"expires_at" timestamp with time zone,
	"shortfall" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"actor" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_ledger_kind_check" CHECK ("kind" IN ('earn', 'redeem', 'reverse', 'adjust', 'expire', 'import')),
	CONSTRAINT "loyalty_ledger_sign_check" CHECK (
		("kind" IN ('earn', 'import') AND "points" >= 0)
		OR ("kind" IN ('redeem', 'expire') AND "points" <= 0)
		OR ("kind" IN ('reverse', 'adjust'))
	),
	CONSTRAINT "loyalty_ledger_shortfall_check" CHECK ("shortfall" >= 0)
);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- order_id / refund_id are deliberately NOT foreign keys: the ledger is an
-- append-only value record that must outlive an order purge (bulk-purge
-- cannot null an order_id on an immutable row, and deleting the rows would
-- silently change a customer's balance). They are provenance references.
CREATE INDEX IF NOT EXISTS "loyalty_ledger_customer_idx" ON "loyalty_ledger" USING btree ("store_id", "customer_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loyalty_ledger_order_idx" ON "loyalty_ledger" USING btree ("order_id") WHERE "order_id" IS NOT NULL;--> statement-breakpoint
-- Idempotency: every system posting carries a deterministic source_ref
-- (earn:<order>, redeem:<order>, refund:<refund>:earn, import:..., ...), so a
-- replayed settle/refund/cancel/import can never post twice.
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_ledger_source_ref_unique" ON "loyalty_ledger" USING btree ("store_id", "source_ref") WHERE "source_ref" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION loyalty_ledger_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'loyalty_ledger is append-only; post a reverse/adjust entry instead';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "loyalty_ledger_no_update" BEFORE UPDATE ON "loyalty_ledger" FOR EACH ROW EXECUTE FUNCTION loyalty_ledger_append_only();--> statement-breakpoint

-- RLS (hand-added — drizzle-kit does not model row-level security).
ALTER TABLE "loyalty_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "loyalty_ledger" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

-- DOWN
-- DROP TABLE "loyalty_ledger";
-- DROP FUNCTION loyalty_ledger_append_only();
