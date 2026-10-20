-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Abandoned-cart recovery: stamp the moment the single reminder email was
-- enqueued for a cart. NULL = never reminded. Additive + nullable; RLS on
-- `cart` is unchanged. The partial index backs the recovery scan (abandoned,
-- unreminded, unconverted carts only).
ALTER TABLE cart ADD COLUMN recovery_emailed_at timestamptz;
--> statement-breakpoint
CREATE INDEX cart_recovery_scan_idx ON cart (store_id, updated_at)
  WHERE status = 'abandoned' AND recovery_emailed_at IS NULL AND converted_order_id IS NULL AND email IS NOT NULL;
