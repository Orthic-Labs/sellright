-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- WS-B (one-click install plan §1.5): demonstration-order flag. Hand-written
-- for the same reason as 0072 — this repo's drizzle-kit snapshot history has
-- already drifted (see docs/runbooks/migrations.md), so `db:generate` would
-- recompute a bogus diff. Additive-only, single boolean column.

ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;

-- DOWN
-- ALTER TABLE "order" DROP COLUMN "is_demo";
