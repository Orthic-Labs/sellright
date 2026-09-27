-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- WS-B follow-up (recovery-kit step-up auth): session.step_up_at records when
-- THIS session last re-verified the admin's password (+ TOTP, if enabled).
-- GET /v1/admin/system/recovery-kit requires this to be within the last 5
-- minutes (see requireStepUp() in routes/admin-helpers.ts) before it will
-- hand back the master key. Hand-written for the same drift reason as
-- 0072-0075 (see docs/runbooks/migrations.md) — a single nullable column.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "step_up_at" timestamp with time zone;

-- DOWN
-- ALTER TABLE "session" DROP COLUMN "step_up_at";
