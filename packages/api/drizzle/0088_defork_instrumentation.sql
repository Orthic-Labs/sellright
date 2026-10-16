-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- De-fork plan 2.9 (instrumentation). Same stale-snapshot drift reason as
-- 0072-0086: drizzle-kit would recompute a bogus diff against this checkout's
-- snapshot, so this carries only the genuinely new objects.
--
-- Expand-only and R0-compatible: every new column is nullable or defaulted, so
-- the PREVIOUS release's INSERTs/UPDATEs keep working unmodified.
--
--  1. webhook_delivery / email_outbox / push_outbox gain claim
--     instrumentation: `claimed_at` (set by the worker at claim, NULL on
--     release) and `first_failed_at` (set once, at the first failure).
--     webhook_delivery additionally gains `updated_at` (it had no
--     last-touched marker at all; the reaper fell back to created_at).
--       - NO trigger: old workers do not write updated_at, so after a
--         rollback the old-runtime projection GREATEST(updated_at, created_at)
--         is conservative (it can only look older than the real claim). A
--         trigger on an existing table would change old-runtime write
--         behaviour (R1), so it is deliberately not part of this migration.
--       - existing 'processing' rows are backfilled to created_at (what the
--         old reaper used as stuck-since). The table is FORCE RLS and this
--         runs without app.current_store, so FORCE is lifted for the UPDATE
--         and restored (an un-lifted UPDATE silently touches 0 rows).
--  2. payment_attempt gains `provider_status` + `provider_observed_at`,
--     advanced ONLY on a successful provider retrieval (never on webhook
--     payloads, never on a failed fetch).
--  3. storekit_event: append-only StoreKit stage log with stage-aware
--     resolution linkage (see docs/INSTRUMENTATION.md).
--
-- Rollback (manual; only safe once no candidate code reads the objects):
--   DROP TABLE storekit_event;
--   ALTER TABLE payment_attempt DROP COLUMN provider_status, DROP COLUMN provider_observed_at;
--   ALTER TABLE webhook_delivery DROP COLUMN claimed_at, DROP COLUMN first_failed_at, DROP COLUMN updated_at;
--   ALTER TABLE email_outbox DROP COLUMN claimed_at, DROP COLUMN first_failed_at;
--   ALTER TABLE push_outbox DROP COLUMN claimed_at, DROP COLUMN first_failed_at;

ALTER TABLE "webhook_delivery" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN IF NOT EXISTS "first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "webhook_delivery" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "webhook_delivery" SET "updated_at" = "created_at" WHERE "status" = 'processing' AND "created_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_delivery" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "email_outbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN IF NOT EXISTS "first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD COLUMN IF NOT EXISTS "first_failed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "payment_attempt" ADD COLUMN IF NOT EXISTS "provider_status" text;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN IF NOT EXISTS "provider_observed_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "storekit_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id"),
  -- Tenant-scoped operation identity (uniqueness is (store_id, operation_id)).
  "operation_id" text NOT NULL,
  "stage" text NOT NULL,
  "outcome" text NOT NULL,
  "error" text,
  -- Set on a FAILED row when a later row of the right stage succeeded for the
  -- same (store_id, operation_id). NULL = unresolved.
  "resolved_by_event_id" uuid REFERENCES "storekit_event"("id"),
  -- clock_timestamp(), not now(): rows written in one transaction (e.g. a
  -- link call's verify + apply) must still order by write order.
  "created_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "storekit_event_stage_check" CHECK ("stage" IN ('verify', 'apply', 'replay')),
  CONSTRAINT "storekit_event_outcome_check" CHECK ("outcome" IN ('ok', 'failed')),
  CONSTRAINT "storekit_event_resolved_only_failed" CHECK ("resolved_by_event_id" IS NULL OR "outcome" = 'failed')
);--> statement-breakpoint

-- Health gate: "unresolved StoreKit" = apply failures with no resolver.
CREATE INDEX IF NOT EXISTS "storekit_event_unresolved_idx"
  ON "storekit_event" ("store_id", "created_at")
  WHERE "outcome" = 'failed' AND "resolved_by_event_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storekit_event_operation_idx"
  ON "storekit_event" ("store_id", "operation_id", "stage");--> statement-breakpoint

ALTER TABLE "storekit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storekit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "storekit_event";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "storekit_event"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
