-- R24 parity: a promotion can combine a percentage/fixed discount WITH free
-- shipping (DD's `order_percentage_discount` + `free_shipping` action pair).
-- `type` stays single-valued; this column layers free shipping on top.
ALTER TABLE "promotion" ADD COLUMN IF NOT EXISTS "free_shipping" boolean DEFAULT false NOT NULL;
