-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Merchant-controlled ordering for product option groups and their values
-- (docs/runbooks/migrations.md's "additive from the previous release's point
-- of view" rule): both new columns are NOT NULL with a DEFAULT, so the
-- previous release's INSERTs (which never set position) keep working
-- unchanged against this schema. Hand-written rather than `db:generate`
-- because the column add needs an accompanying DATA backfill — drizzle-kit
-- only diffs schema, never writes data-migration logic (same class as
-- 0075_promote_installation_admin).
--
-- Backfill order: neither table carries a created_at column, and `id` is a
-- random-default uuid (defaultRandom(), not time-sortable), so there is no
-- timestamp or monotonic key to backfill from. `ctid` (physical row order)
-- is the only available proxy for "the order these rows were inserted in,
-- i.e. the order they already display in today" — the admin API's existing
-- GET before this migration has no ORDER BY at all, so it was already
-- relying on incidental heap order. This runs once, at migration time, over
-- whatever rows already exist. Every row created AFTER this migration gets
-- an explicit position from the application (routes/admin-catalog.ts),
-- never from ctid.

ALTER TABLE product_option_group ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE product_option ADD COLUMN position integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY product_id ORDER BY ctid) - 1 AS rn
  FROM product_option_group
)
UPDATE product_option_group g
SET position = ranked.rn
FROM ranked
WHERE ranked.id = g.id;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY group_id ORDER BY ctid) - 1 AS rn
  FROM product_option
)
UPDATE product_option o
SET position = ranked.rn
FROM ranked
WHERE ranked.id = o.id;

-- Ordering indexes: every read path added in this change (catalog.ts,
-- admin-catalog.ts, manifest/catalog.ts) filters by product_id/group_id and
-- orders by position — same access shape as the existing
-- product_asset/variant_asset position columns, which are read via their
-- primary key and never needed a dedicated index. These two tables are
-- looked up by productId/groupId (not PK) first, so a composite index pays
-- for itself on any catalog with more than a handful of option groups.
CREATE INDEX product_option_group_product_position_idx ON product_option_group (product_id, position, id);
CREATE INDEX product_option_position_idx ON product_option (group_id, position, id);
