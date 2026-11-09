-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- DB-M2: the outbox poll indexes covered every status, so they grew with every sent/delivered row ever written. The poll
-- queries only ever look at open work, so each index becomes partial on the open statuses and matches the poll shape:
--   email_outbox / push_outbox   WHERE (status='pending' AND next_attempt_at <= now()) OR (status='processing' AND updated_at < ...)
--                                ORDER BY next_attempt_at LIMIT n   (RLS adds store_id = current store)
--   webhook_delivery             WHERE store_id = $1 AND status='pending' AND next_attempt_at <= $2 ORDER BY next_attempt_at, id LIMIT 1
-- Each arm of those predicates implies status IN ('pending','processing'), so the planner can prove the partial index
-- from the query's literal status text, which FORCE RLS does not restrict (status is text; texteq is leakproof). store_id
-- leads so the tenant qual is an index condition, then the ORDER BY column(s) come out of the index in order.
-- The replaced indexes (status, next_attempt_at) are dropped after their replacements exist; any other reader of those
-- tables (reaper, canary, retention job) scans small, retention-bounded tables. Old images keep working: only the
-- planner's choice of index changes, never a query's result.
-- Additive build, then DROP of the superseded index; the three tables are tens to thousands of rows at current sizes
-- (largest table in the system is 149 MB), so plain builds hold the write lock for milliseconds, no CONCURRENTLY needed.
CREATE INDEX IF NOT EXISTS "email_outbox_open_due_idx" ON "email_outbox" ("store_id", "next_attempt_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_outbox_open_due_idx" ON "push_outbox" ("store_id", "next_attempt_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_delivery_open_due_idx" ON "webhook_delivery" ("store_id", "next_attempt_at", "id") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
DROP INDEX IF EXISTS "email_outbox_due_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "push_outbox_due_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "webhook_delivery_poll_idx";
-- DOWN (never run automatically): DROP INDEX IF EXISTS email_outbox_open_due_idx, push_outbox_open_due_idx, webhook_delivery_open_due_idx;
--   CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON email_outbox (status, next_attempt_at);
--   CREATE INDEX IF NOT EXISTS push_outbox_due_idx ON push_outbox (status, next_attempt_at);
--   CREATE INDEX IF NOT EXISTS webhook_delivery_poll_idx ON webhook_delivery (status, next_attempt_at);
