-- Custom SQL migration file, put your code below! --

-- Order soft-delete (trash). Additive, nullable: null = live, non-null = trashed
-- (hidden from every order read, restorable). Purge hard-deletes the row + its
-- children. Mirrors the product/variant deletedAt convention. RLS posture on
-- "order" is unchanged (already FORCE-RLS'd) — this is additive.
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;--> statement-breakpoint
-- Order reads filter on deleted_at IS NULL on every list/dashboard/report/export;
-- index the common (store, deleted_at) selectivity so trashed rows are cheaply
-- excluded.
CREATE INDEX IF NOT EXISTS order_store_deleted_idx ON "order" (store_id, deleted_at);
