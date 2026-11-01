-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Job sweep and refund lookup indexes (perf/pg/POSTGRES-REPORT.md F2-F4, F6). Under FORCE RLS a qual on an enum column
-- (`state = ...`) is not leakproof, so it can never be an index condition and every state-filtered sweep read the whole
-- table. A partial index is proved from the query's literal state predicate instead, which RLS does not restrict.
-- refund.order_id backs the per-order refund sums, the purge NOT EXISTS and the FK check on an order purge.
-- Additive and tiny (tens of kB); a plain build holds the write lock for milliseconds.
CREATE INDEX IF NOT EXISTS "refund_order_idx" ON "refund" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_pending_created_idx" ON "order" ("store_id", "created_at") WHERE "state" = 'PendingPayment';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_cancelled_created_idx" ON "order" ("store_id", "created_at") WHERE "state" = 'Cancelled';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillment_shipped_order_idx" ON "fulfillment" ("store_id", "order_id") WHERE "state" = 'Shipped';
-- DOWN (never run automatically): DROP INDEX IF EXISTS refund_order_idx, order_pending_created_idx,
--   order_cancelled_created_idx, fulfillment_shipped_order_idx; (no data changes; the previous image never names them).
