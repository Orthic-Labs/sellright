-- Custom SQL migration file, put your code below! --

-- Cart lifecycle (server-authoritative cart, Phase A): a hard TTL the cleanup
-- job uses to delete idle/empty carts, plus an index that backs the
-- store-scoped abandonment scan (active carts with no recent activity).
-- Additive + nullable — RLS posture on `cart` is unchanged.
ALTER TABLE cart ADD COLUMN IF NOT EXISTS expires_at timestamptz;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cart_expires_idx ON cart (expires_at);--> statement-breakpoint
-- abandonment scan: store-scoped, by status + activity recency.
CREATE INDEX IF NOT EXISTS cart_store_status_updated_idx ON cart (store_id, status, updated_at);
