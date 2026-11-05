-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Saved admin accounts (#355, phase 2): the hub side. A browser holds one hub session (sr_hub cookie; only its sha256 is
-- stored). Each enrolled account is a slot holding the TARGET server's bearer session, sealed with AES-256-GCM
-- (auth/hub-vault.ts; keys from HUB_VAULT_KEYS, never in the database) and bound to its slot id, hub session and target.
-- An enrolment row lives 10 minutes: the hashed state plus the sealed PKCE verifier for one target, spent once on the
-- callback (delete ... returning). Global tables like admin_handoff_code (no store_id, so no RLS). Additive: the previous
-- image never reads them. Runtime grants follow schema-owner default privileges.
CREATE TABLE "hub_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "hub_session_expires" ON "hub_session"("expires_at");--> statement-breakpoint
CREATE TABLE "hub_enrolment" (
  "state_hash" text PRIMARY KEY,
  "hub_session_id" uuid NOT NULL REFERENCES "hub_session"("id") ON DELETE CASCADE,
  "target_id" text NOT NULL,
  "verifier_sealed" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "hub_enrolment_expires" ON "hub_enrolment"("expires_at");--> statement-breakpoint
CREATE TABLE "hub_account_slot" (
  "id" uuid PRIMARY KEY,
  "hub_session_id" uuid NOT NULL REFERENCES "hub_session"("id") ON DELETE CASCADE,
  "target_id" text NOT NULL,
  "admin_id" text NOT NULL,
  "admin_email" text NOT NULL,
  "token_sealed" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "hub_account_slot_identity" ON "hub_account_slot"("hub_session_id", "target_id", "admin_id");
-- DOWN (never run automatically): DROP TABLE "hub_account_slot", "hub_enrolment", "hub_session" (the previous image reads none).
