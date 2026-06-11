-- 0022_indexes.sql — WP9.7 (audit §4 perf list, 2026-06-10).
-- Hot-path indexes that the planner currently has to seq-scan as data grows.
-- Every column name is verified against db/schema.ts.
-- Each index is on a store-scoped table that already has FORCE RLS, so the
-- index lookups inherit the RLS predicate naturally.

CREATE INDEX IF NOT EXISTS customer_store_idx         ON customer (store_id, created_at);
CREATE INDEX IF NOT EXISTS address_customer_idx       ON address (customer_id);
CREATE INDEX IF NOT EXISTS product_variant_product_idx ON product_variant (product_id);
CREATE INDEX IF NOT EXISTS collection_product_collection_idx ON collection_product (collection_id);
CREATE INDEX IF NOT EXISTS fulfillment_line_fulfillment_idx ON fulfillment_line (fulfillment_id);
CREATE INDEX IF NOT EXISTS refund_line_refund_idx     ON refund_line (refund_id);
CREATE INDEX IF NOT EXISTS return_line_return_idx     ON return_line (return_id);
CREATE INDEX IF NOT EXISTS webhook_delivery_poll_idx  ON webhook_delivery (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS cart_customer_idx          ON cart (customer_id);
CREATE INDEX IF NOT EXISTS cart_store_status_idx      ON cart (store_id, status);
CREATE INDEX IF NOT EXISTS order_store_placed_idx     ON "order" (store_id, placed_at);
CREATE INDEX IF NOT EXISTS stock_store_idx            ON stock (store_id);

-- WP1.7 (perf): missing index on the customer_token table once it lands
-- (WP2d). Pre-emptive since token lookups happen on every password-reset /
-- email-verify request and a seq scan is the most likely failure mode at
-- the volume DD's import will produce.
-- CREATE INDEX IF NOT EXISTS customer_token_hash_idx ON customer_token (token_hash);
