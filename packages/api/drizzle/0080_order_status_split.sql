-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- This repo's drizzle-kit snapshot history has already drifted (see the
-- runbook's 0072-0076 entries) — `drizzle-kit generate` against current HEAD
-- recomputes a bogus multi-hundred-line diff re-adding everything shipped
-- since the last real snapshot. Verified by running it once and discarding
-- the output in favor of this hand-authored file (same precedent as 0072-0076).
--
-- Order/payment/fulfillment status split (backend de-Vendure work): `order`
-- exposes a wire-facing lifecycle `status` alongside the existing combined
-- `state` FSM (money/fsm.ts — UNCHANGED, still the source of truth for every
-- transition guard in the codebase). `status` is a Postgres STORED GENERATED
-- column computed from `state` + `deleted_at` on the SAME row only, so it is
-- backfilled automatically for every existing row the instant this migration
-- runs (Postgres computes a STORED generated column for pre-existing rows
-- when the column is added) and can never drift from the state it mirrors —
-- no application code ever writes to it, and none should.
--
-- paymentStatus and fulfillmentStatus (the other two wire fields the API now
-- exposes — see orders/status.ts) are DELIBERATELY NOT persisted columns
-- here. Unlike `status`, they depend on OTHER tables (`payment`,
-- `order_line`, `fulfillment`) that change at many independent call sites
-- across checkout/payments/refunds/admin-order-ops. Persisting them would
-- mean either (a) a trigger — the exact class of migration complexity this
-- repo's own hand-written-migration precedents (0049, 0070) treat as a last
-- resort — or (b) manual dual-write added to every one of those call sites,
-- which is a correctness hazard the first time a future PR adds a new one
-- and forgets the extra write. orders/status.ts computes them at READ time
-- instead (mirrors the existing `PAID_STATES` sql-fragment pattern in
-- admin-helpers.ts), which is always correct by construction. Tracked as a
-- deliberate follow-up if list-query performance ever requires persisting +
-- indexing them (see CHANGELOG.md).
--
-- `status` is `text`, not a Postgres enum: Postgres's enum I/O/cast
-- functions are STABLE, not IMMUTABLE (ALTER TYPE ... ADD VALUE can change
-- the catalog), so a GENERATED ALWAYS AS expression can never resolve to an
-- enum type — this fails at DDL time with "generation expression is not
-- immutable" no matter how the expression casts. A CHECK constraint keeps
-- the same closed-set guarantee an enum would have given.
ALTER TABLE "order" ADD COLUMN "status" text GENERATED ALWAYS AS (case
    when deleted_at is not null then 'archived'
    when state = 'Cancelled' then 'cancelled'
    when state = 'PendingPayment' then 'open'
    else 'completed'
  end) STORED NOT NULL;

ALTER TABLE "order" ADD CONSTRAINT "order_status_check" CHECK ("status" IN ('open', 'completed', 'cancelled', 'archived'));

CREATE INDEX "order_store_status_idx" ON "order" ("store_id", "status");
