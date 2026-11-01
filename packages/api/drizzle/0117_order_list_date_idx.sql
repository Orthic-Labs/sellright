-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Admin order list + dashboard "recent orders" sort: coalesce(placed_at, created_at) desc, id desc over live orders
-- (routes/admin.ts, routes/admin-dashboard.ts; EGM PG-3). No index matched, so every list page sorted the whole store's
-- order heap (perf DB: 7.8 ms / 2,728 buffers -> 0.09 ms / 7 buffers for page 1). coalesce, IS NULL and the uuid /
-- timestamptz comparisons are leakproof, so FORCE RLS does not block the index. The from/to date filters use it too.
-- Additive; about 1 MB on a 20k-order table; a plain build holds the write lock for milliseconds.
CREATE INDEX IF NOT EXISTS "order_store_orderdate_live_idx" ON "order" ("store_id", (coalesce("placed_at", "created_at")) DESC, "id" DESC) WHERE "deleted_at" IS NULL;
-- DOWN (never run automatically): DROP INDEX IF EXISTS order_store_orderdate_live_idx; (the previous image never names it).
