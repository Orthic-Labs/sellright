-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Installation-wide key/value settings (plan 2.7). First user: `config_fingerprint_salt`,
-- the random >=32-byte salt that keys the HMAC fingerprints of
-- GET /v1/admin/system/effective-config. Generated server-side on first use, never
-- derived from any secret, never returned by any endpoint; because it lives in the
-- database, two runtimes on the same database produce equal fingerprints for equal secrets.
-- Global infra table: no store_id, no RLS (same posture as rate_limit_attempt, 0078).
CREATE TABLE installation_setting (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
