-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0097: admin MFA hardening (security audit 2026-10-15, P1b).
--  (1) admin_recovery_code: one-time 2FA recovery codes. Only sha256(code) is stored (codes carry 80 random
--      bits, so an offline guess against the hash is infeasible); used_at marks a spent code. Global registry
--      table like admin_user / session (resolved before any store context), so RLS-EXEMPT and no store_id.
--  (2) No column change for admin_user.totp_secret: encryption at rest reuses the text column with an
--      'enc1:' prefix (src/auth/totp-secret.ts); legacy plaintext rows keep working and are sealed by the
--      API at start when SELLRIGHT_MASTER_KEY is set. Expand-only.
--  (3) admin_totp_used_step: every accepted TOTP time-step per admin. verifying a code INSERTs (admin, step) with
--      ON CONFLICT DO NOTHING; no row returned = the step was already used = replay, rejected. Durable and atomic
--      across API processes and restarts (was: last step per admin in process memory only). Rows older than the
--      ±1-step window are pruned opportunistically. Global registry, RLS-exempt like admin_recovery_code.
-- Rollback: DROP TABLE admin_recovery_code; DROP TABLE admin_totp_used_step. Before running an OLDER engine against this database, run
--   node dist/scripts/totp-secrets.js --decrypt   (older engines read totp_secret as plaintext base32).
CREATE TABLE IF NOT EXISTS "admin_recovery_code" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE cascade,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_recovery_code_user_hash_idx" ON "admin_recovery_code" ("admin_user_id", "code_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_totp_used_step" (
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE cascade,
  "step" bigint NOT NULL,
  "used_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("admin_user_id", "step")
);
