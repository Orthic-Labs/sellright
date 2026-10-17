-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Expand coupon membership without recomputing historical money or edit evidence.
-- Native carts previously had no persisted coupon field, so their default is empty.
ALTER TABLE cart ADD COLUMN IF NOT EXISTS coupon_codes text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS coupon_codes text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb;--> statement-breakpoint
-- Preserve stored code identity exactly. Source coupon equality is case-insensitive
-- without whitespace normalization; promotion_id remains compatibility attribution.
UPDATE "order" o
SET coupon_codes = ARRAY[p.code]
FROM promotion p
WHERE o.promotion_id = p.id
  AND o.store_id = p.store_id
  AND cardinality(o.coupon_codes) = 0
  AND p.code IS NOT NULL
  AND p.code <> '';
--> statement-breakpoint
-- Native legacy promotions retain line semantics; source order actions import explicitly.
ALTER TABLE promotion ADD COLUMN discount_scope text NOT NULL DEFAULT 'line';--> statement-breakpoint
ALTER TABLE promotion ADD COLUMN stack_order integer;--> statement-breakpoint
ALTER TABLE promotion ADD CONSTRAINT promotion_discount_scope_check CHECK (discount_scope IN ('line', 'order'));--> statement-breakpoint
ALTER TABLE promotion ADD CONSTRAINT promotion_stack_order_check CHECK (stack_order IS NULL OR stack_order >= 0);
