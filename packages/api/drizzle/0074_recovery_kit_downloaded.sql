-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- WS-B (one-click install plan §1.10): tracks whether the installation admin
-- has downloaded the recovery kit — gates Publish. Same drift reason as
-- 0072/0073 (see docs/runbooks/migrations.md); a single nullable timestamp
-- column, hand-written only to avoid re-triggering the same bogus
-- `db:generate` diff.

ALTER TABLE "admin_user" ADD COLUMN IF NOT EXISTS "recovery_kit_downloaded_at" timestamp with time zone;

-- DOWN
-- ALTER TABLE "admin_user" DROP COLUMN "recovery_kit_downloaded_at";
