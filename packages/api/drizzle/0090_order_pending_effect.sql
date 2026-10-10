-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Same stale-snapshot drift reason as 0072-0086: drizzle-kit would recompute a
-- bogus diff against this checkout's snapshot, so this carries ONLY the four
-- additive tables below.
--
-- Settlement operations and pending effects (de-fork plan 2.8; normative design:
-- SETTLEMENT-OPS.md, INVOICE-DISPOSITIONS.md in the RightSites docs/defork set;
-- engine docs: docs/PENDING-EFFECTS.md).
--
--  * settlement_operation: one row per settlement FACT, keyed by the provider /
--    business identity (invoice id, payment id, order id, order-edit id) and not
--    by the code path that observed it. UNIQUE (store_id, operation_kind,
--    operation_id) makes a replay of the same fact a no-op whichever path
--    replays it. An invoice's classification and authorized effect set are
--    frozen here on first observation.
--  * order_pending_effect: the effects an operation authorizes (licence
--    issue/extension, edit reconcile, loyalty earn, notification, admin review),
--    written in the SAME transaction as the money/state mutation and executed
--    exactly once. status pending -> processing -> done | terminal. A worker
--    claims a row with a fresh claim_token + claimed_at; a claim older than
--    5 minutes is reclaimed with a NEW token and every write checks the token
--    (fencing). Local effects commit their mutations in the same transaction as
--    `done`. terminal = retries exhausted or an effect refused for automatic
--    application; it is admin-visible.
--  * applied_operation_receipt: for effects that call a provider — the provider
--    call uses the effect id as idempotency key and the receipt is written in
--    the same transaction as `done`; a retry that finds a receipt skips the call.
--  * subscription_invoice_payment: money record for a subscription invoice that
--    has no backing order (payment.order_id is NOT NULL). INVOICE-DISPOSITIONS 7.2.
--
-- Expand-only: new tables, nothing the previous release touches. Every FK to
-- store(id) is ON DELETE CASCADE (the previous release deletes stores, and it
-- does not know these tables, so a NO ACTION FK would block its writes, R1);
-- order_id / payment_id / license_id columns are plain uuids with no FK, so an
-- order purge is never blocked. RLS matches payment / email_outbox:
-- tenant_isolation, FORCE.

CREATE TABLE IF NOT EXISTS "settlement_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"classification" text,
	"authorized_effects" text[] DEFAULT '{}'::text[] NOT NULL,
	"disposition" text,
	"payment_id" uuid,
	"order_id" uuid,
	"license_id" uuid,
	"invoice_payment_id" uuid,
	"payment_intent" text,
	"provider_account" text,
	"provider_mode" text,
	"target_kind" text,
	"target_id" text,
	"actor" text,
	"reason" text,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_operation_kind_check" CHECK ("operation_kind" IN ('stripe_invoice_paid', 'payment_settled', 'payment_state_progress', 'order_paid_transition', 'admin_draft_create', 'order_edit_balance_settled', 'duplicate_capture_recorded', 'historical_import', 'synthetic_seed', 'payment_mode_corrected', 'order_purge', 'operator_resolution')),
	CONSTRAINT "settlement_operation_resolution_check" CHECK (("operation_kind" = 'operator_resolution') = ("target_kind" IS NOT NULL AND "target_id" IS NOT NULL AND "actor" IS NOT NULL AND "reason" IS NOT NULL)),
	CONSTRAINT "settlement_operation_classification_check" CHECK ("classification" IS NULL OR "classification" IN ('first_cycle', 'renewal', 'adjustment', 'unresolved')),
	CONSTRAINT "settlement_operation_identity" UNIQUE ("store_id", "operation_kind", "operation_id")
);--> statement-breakpoint
ALTER TABLE "settlement_operation" ADD CONSTRAINT "settlement_operation_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- At most one entitlement-bearing operator resolution per held target.
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_operation_resolution_uidx" ON "settlement_operation" USING btree ("store_id", "target_kind", "target_id") WHERE "operation_kind" = 'operator_resolution' AND "authorized_effects" <> '{}';--> statement-breakpoint
ALTER TABLE "settlement_operation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settlement_operation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "settlement_operation" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "order_pending_effect" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"effect_kind" text NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_failed_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"resolved_by" uuid,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_pending_effect_status_check" CHECK ("status" IN ('pending', 'processing', 'done', 'terminal')),
	CONSTRAINT "order_pending_effect_kind_check" CHECK ("effect_kind" IN ('license_issue', 'license_extend', 'loyalty_earn', 'notification', 'edit_reconcile', 'admin_review')),
	CONSTRAINT "order_pending_effect_claim_check" CHECK ("status" <> 'processing' OR ("claim_token" IS NOT NULL AND "claimed_at" IS NOT NULL)),
	CONSTRAINT "order_pending_effect_identity" UNIQUE ("store_id", "operation_kind", "operation_id", "effect_kind")
);--> statement-breakpoint
ALTER TABLE "order_pending_effect" ADD CONSTRAINT "order_pending_effect_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_pending_effect" ADD CONSTRAINT "order_pending_effect_resolved_by_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."settlement_operation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_pending_effect" ADD CONSTRAINT "order_pending_effect_operation_fk" FOREIGN KEY ("store_id", "operation_kind", "operation_id") REFERENCES "public"."settlement_operation"("store_id", "operation_kind", "operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Worker claim path (due pending + stale processing) and the admin list of
-- terminal rows. Partial: 'done' rows are the overwhelming majority.
CREATE INDEX IF NOT EXISTS "order_pending_effect_due_idx" ON "order_pending_effect" USING btree ("status", "next_attempt_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_pending_effect_terminal_idx" ON "order_pending_effect" USING btree ("store_id", "updated_at" DESC) WHERE "status" = 'terminal';--> statement-breakpoint
ALTER TABLE "order_pending_effect" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_pending_effect" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_pending_effect" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "applied_operation_receipt" (
	"effect_id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "applied_operation_receipt" ADD CONSTRAINT "applied_operation_receipt_effect_id_fk" FOREIGN KEY ("effect_id") REFERENCES "public"."order_pending_effect"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applied_operation_receipt" ADD CONSTRAINT "applied_operation_receipt_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applied_operation_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applied_operation_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "applied_operation_receipt" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subscription_invoice_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid,
	"stripe_account_id" text NOT NULL,
	"mode" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"provider_ref" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text,
	"state" "payment_state" DEFAULT 'Settled' NOT NULL,
	"paid_at" timestamp with time zone,
	"billing_reason" text,
	"origin" text NOT NULL,
	"disposition" text,
	"frontier_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoice_payment_mode_check" CHECK ("mode" IN ('test', 'live')),
	CONSTRAINT "subscription_invoice_payment_amount_check" CHECK ("amount" >= 0),
	CONSTRAINT "subscription_invoice_payment_origin_check" CHECK ("origin" IN ('live', 'historical_backfill'))
);--> statement-breakpoint
ALTER TABLE "subscription_invoice_payment" ADD CONSTRAINT "subscription_invoice_payment_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_invoice_payment_invoice_uidx" ON "subscription_invoice_payment" USING btree ("store_id", "stripe_account_id", "mode", "invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_invoice_payment_ref_idx" ON "subscription_invoice_payment" USING btree ("store_id", "provider_ref");--> statement-breakpoint
ALTER TABLE "subscription_invoice_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_invoice_payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_invoice_payment" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

-- DOWN
-- DROP TABLE "subscription_invoice_payment";
-- DROP TABLE "applied_operation_receipt";
-- DROP TABLE "order_pending_effect";
-- DROP TABLE "settlement_operation";
