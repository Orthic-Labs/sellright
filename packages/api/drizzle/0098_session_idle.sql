-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0098: admin idle-session timeout (security audit 2026-10-15, P2). session.last_seen_at is touched (at most once a
-- minute) when an admin session is used; resolveAdmin refuses a session idle for longer than
-- ADMIN_SESSION_IDLE_HOURS (default 12). NULL (rows from before this migration) falls back to created_at.
-- Expand-only, nullable, no backfill. Rollback: ALTER TABLE "session" DROP COLUMN "last_seen_at".
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
