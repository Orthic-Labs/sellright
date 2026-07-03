-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- The snapshot drift between the live schema and what `drizzle-kit generate`
-- would emit from the current schema is intentional (the cart table was
-- reshaped after 0031_realign_snapshot). Regenerating produces a migration
-- that double-ALTERs and breaks `pnpm db:migrate` on a fresh DB.

-- Custom SQL migration file, put your code below! --

-- Cart lifecycle (server-authoritative cart, Phase A): a hard TTL the cleanup
-- job uses to delete idle/empty carts, plus an index that backs the
-- store-scoped abandonment scan (active carts with no recent activity).
-- Additive + nullable — RLS posture on `cart` is unchanged.
ALTER TABLE cart ADD COLUMN IF NOT EXISTS expires_at timestamptz;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cart_expires_idx ON cart (expires_at);--> statement-breakpoint
-- abandonment scan: store-scoped, by status + activity recency.
CREATE INDEX IF NOT EXISTS cart_store_status_updated_idx ON cart (store_id, status, updated_at);
