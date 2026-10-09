-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Same stale-snapshot drift reason as 0072-0085: drizzle-kit would recompute a
-- bogus diff against this checkout's snapshot, so this carries ONLY the two
-- additive columns.
--
-- Persists the shipping method an order was placed with (code + display name
-- snapshot), so order detail/list/export can show it and order editing no
-- longer has to infer it from the stored shipping total. Both nullable: legacy
-- orders (and orders with no shipping line) stay NULL; the order-edit
-- inference fallback remains for NULL. No backfill. Expand-only: the previous
-- release's INSERTs keep working unmodified.
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "shipping_method_code" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "shipping_method_name" text;
