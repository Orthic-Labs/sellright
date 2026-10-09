-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Same stale-snapshot drift reason as 0072-0090: drizzle-kit would recompute a
-- bogus diff against this checkout's snapshot, so this carries ONLY the table below.
--
-- order_reservation (de-fork plan 3.3; normative design: PAYMENT-TIMING.md §3.2–§3.3
-- in the RightSites docs/defork set). Durable, provider-aware holds that an order
-- places on a thing another order must not also take (e.g. an upgrade credit).
--
--  * held -> consumed by the settlement that moves the order to Paid (same tx).
--  * held -> released only when the order is terminal (Cancelled / Refunded) AND the
--    provider quiescence predicate holds (evaluated under the order lock). Retryable
--    provider failures keep the hold.
--  * consumed -> released on a full refund when release_on_full_refund is set.
--  * UNIQUE (store_id, kind, owner_key) over live states: one live holder per thing.
--
-- Expand-only: a new table, nothing the previous release touches. store and order
-- FKs are ON DELETE CASCADE so an existing store or order delete never blocks on it.
-- consumed_payment_id is ON DELETE SET NULL for the same reason. RLS matches
-- payment / payment_attempt: tenant_isolation, FORCE.
-- Rollback: DROP TABLE order_reservation (safe while no policy has registered a kind).

CREATE TABLE IF NOT EXISTS "order_reservation" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id"               uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "order_id"               uuid NOT NULL REFERENCES "order"("id") ON DELETE CASCADE,
  "kind"                   text NOT NULL,
  "owner_key"              text NOT NULL,
  "state"                  text NOT NULL DEFAULT 'held',
  "holder"                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  "release_on_full_refund" boolean NOT NULL DEFAULT false,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"             timestamp with time zone,
  "release_requested_at"   timestamp with time zone,
  "release_reason"         text,
  "released_at"            timestamp with time zone,
  "released_unverified"    boolean NOT NULL DEFAULT false,
  "consumed_at"            timestamp with time zone,
  "consumed_payment_id"    uuid REFERENCES "payment"("id") ON DELETE SET NULL,
  "consumed_operation_id"  text,
  "provider_terminal_at"   timestamp with time zone,
  CONSTRAINT "order_reservation_state_check" CHECK ("state" IN ('held', 'consumed', 'released')),
  CONSTRAINT "order_reservation_shape_check" CHECK (
    ("state" = 'held'     AND "consumed_at" IS NULL AND "released_at" IS NULL AND "provider_terminal_at" IS NULL) OR
    ("state" = 'consumed' AND "consumed_at" IS NOT NULL AND "provider_terminal_at" IS NOT NULL AND "released_at" IS NULL) OR
    ("state" = 'released' AND "released_at" IS NOT NULL AND "provider_terminal_at" IS NOT NULL)),
  CONSTRAINT "order_reservation_order_owner" UNIQUE ("order_id", "kind", "owner_key")
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_reservation_live_owner"
  ON "order_reservation" ("store_id", "kind", "owner_key") WHERE "state" IN ('held', 'consumed');
CREATE INDEX IF NOT EXISTS "order_reservation_order_idx" ON "order_reservation" ("store_id", "order_id");
CREATE INDEX IF NOT EXISTS "order_reservation_release_pending"
  ON "order_reservation" ("store_id", "release_requested_at") WHERE "state" = 'held' AND "release_requested_at" IS NOT NULL;

ALTER TABLE "order_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_reservation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "order_reservation";
CREATE POLICY "tenant_isolation" ON "order_reservation"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
