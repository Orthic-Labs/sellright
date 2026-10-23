-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Admin sign-in journey (issue #333). One global table for the short-lived, single-use server-side tokens of the
-- admin auth flow; only sha256(token) is stored:
--   login_2fa       POST /v1/admin/login answered a correct password for an account with a second factor; the token
--                   is redeemed once by POST /v1/admin/login/2fa with the code. Bound to the security epoch and a
--                   digest of the verified password hash, so any credential or 2FA change kills it. Attempt-capped.
--   totp_enroll     the pending authenticator secret of ONE session (POST /v1/admin/2fa/setup), sealed like
--                   admin_user.totp_secret; replaced on every setup call, consumed by POST /v1/admin/2fa/enable.
--   password_reset  the e-mailed reset link (POST /v1/admin/password/forgot -> /reset), bound to the epoch and the
--                   password-hash digest it was issued for.
-- Global like admin_passkey_challenge (resolved before any store context; no store_id, so no RLS).
-- Additive: the previous image never reads the table. Runtime grants follow schema-owner default privileges.
CREATE TABLE "admin_auth_challenge" (
  "token_hash" text PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('login_2fa','totp_enroll','password_reset')),
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "session_hash" text,
  "credential_digest" text,
  "secret" text,
  "epoch" integer NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "admin_auth_challenge_attempts" CHECK ("attempts" >= 0),
  CONSTRAINT "admin_auth_challenge_shape" CHECK (
    ("kind" = 'login_2fa' AND "credential_digest" IS NOT NULL AND "session_hash" IS NULL AND "secret" IS NULL) OR
    ("kind" = 'totp_enroll' AND "session_hash" IS NOT NULL AND "secret" IS NOT NULL AND "credential_digest" IS NULL) OR
    ("kind" = 'password_reset' AND "credential_digest" IS NOT NULL AND "session_hash" IS NULL AND "secret" IS NULL))
);--> statement-breakpoint
CREATE INDEX "admin_auth_challenge_admin" ON "admin_auth_challenge"("admin_user_id", "kind");--> statement-breakpoint
CREATE INDEX "admin_auth_challenge_expires" ON "admin_auth_challenge"("expires_at");
-- DOWN (never run automatically): DROP TABLE "admin_auth_challenge" (the previous image never reads it).
