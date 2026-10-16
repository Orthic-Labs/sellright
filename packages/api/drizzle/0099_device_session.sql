-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0099: bind a push / Live Activity device registration to the admin SESSION that made it (security plan rev 8,
-- B2.16). Signing out (or any session revocation: revoke-sessions, password change, idle expiry) deletes the session
-- and, via ON DELETE CASCADE, every device token that session registered — both 'apns' and 'live_activity' — so a
-- signed-out phone stops receiving this store's orders and Live Activities. Registration takes FOR SHARE on its own
-- session, so a registration racing a logout either lands first (and is cascaded) or finds no session (401).
-- Legacy registrations cannot prove a live session. Remove them; each app must re-register on launch.
-- Expand-only. Rollback: ALTER TABLE "admin_device_token" DROP COLUMN "session_id".
ALTER TABLE "admin_device_token" ADD COLUMN IF NOT EXISTS "session_id" uuid REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_device_token_session_idx" ON "admin_device_token" ("session_id");

--> statement-breakpoint
DELETE FROM "admin_device_token" WHERE "session_id" IS NULL;
