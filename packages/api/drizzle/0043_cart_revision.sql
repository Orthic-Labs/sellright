-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- CART-03: monotonic optimistic-concurrency counter on cart. Every mutation
-- (line write, identity capture, merge, conversion, lifecycle-job transition)
-- bumps it; writers that pass an expectedRevision get a 409 + the current
-- snapshot on staleness instead of a silent last-writer-wins overwrite.
-- Additive + defaulted — RLS posture on `cart` is unchanged.
ALTER TABLE cart ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
