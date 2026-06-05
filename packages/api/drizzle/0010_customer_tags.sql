-- Customer tags (segmentation) — admin can tag customers for filtering.
ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "tags" text[];
