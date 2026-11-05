-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Order edits keep an order line's ORIGINALLY ORDERED quantity (order_line.quantity) and record the unfulfilled units an
-- edit removed as cancelled (cancelled_qty). edit_removed_qty is the subset of cancelled_qty removed by an order EDIT
-- (billing removed them: the line total, the order totals and every display use quantity - edit_removed_qty), as opposed
-- to units cancelled by a refund / cancellation, which stay billed. Existing rows default to 0, so their quantity keeps
-- meaning what it meant (no backfill). Additive; NOT NULL DEFAULT 0 is a metadata-only change on PG 11+; the previous
-- image never reads it. The CHECK is NOT VALID (no table scan; every existing row satisfies it trivially, 0 <= cancelled_qty).
ALTER TABLE "order_line" ADD COLUMN IF NOT EXISTS "edit_removed_qty" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_edit_removed_qty_chk" CHECK ("edit_removed_qty" >= 0 AND "edit_removed_qty" <= "cancelled_qty") NOT VALID;
-- DOWN (never run automatically): ALTER TABLE "order_line" DROP CONSTRAINT "order_line_edit_removed_qty_chk"; ALTER TABLE "order_line" DROP COLUMN "edit_removed_qty" (the previous image never reads it).
