-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Passkeys (WebAuthn) for admins and customers + the per-owner security epoch
-- (docs/plans/2026-10-21-passkeys-and-federated-signin.md §4, §6). Additive: the previous image runs unchanged
-- against this schema; the triggers fire under any image and keep credentials/step-ups honest across a rollback.
ALTER TABLE "admin_user" ADD COLUMN "security_epoch" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "security_epoch" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "step_up_epoch" integer;--> statement-breakpoint
CREATE TABLE "admin_passkey_credential" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "rp_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "public_key" bytea NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "transports" text[] NOT NULL DEFAULT '{}',
  "device_type" text NOT NULL,
  "backed_up" boolean NOT NULL,
  "aaguid" text,
  "label" text NOT NULL,
  "epoch" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  CONSTRAINT "admin_passkey_credential_rp_cred" UNIQUE ("rp_id", "credential_id")
);--> statement-breakpoint
CREATE INDEX "admin_passkey_credential_admin" ON "admin_passkey_credential"("admin_user_id");--> statement-breakpoint
CREATE TABLE "admin_passkey_challenge" (
  "challenge_hash" text PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('register','login','step_up')),
  "rp_id" text NOT NULL,
  "admin_user_id" uuid REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "session_hash" text,
  "nonce_hash" text NOT NULL,
  "epoch" integer,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "admin_passkey_challenge_shape" CHECK (
    ("kind" = 'login' AND "admin_user_id" IS NULL AND "session_hash" IS NULL AND "epoch" IS NULL) OR
    ("kind" <> 'login' AND "admin_user_id" IS NOT NULL AND "session_hash" IS NOT NULL AND "epoch" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "admin_passkey_challenge_expires" ON "admin_passkey_challenge"("expires_at");--> statement-breakpoint
CREATE TABLE "customer_passkey_credential" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "rp_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "public_key" bytea NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "transports" text[] NOT NULL DEFAULT '{}',
  "device_type" text NOT NULL,
  "backed_up" boolean NOT NULL,
  "aaguid" text,
  "label" text NOT NULL,
  "epoch" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  CONSTRAINT "customer_passkey_credential_rp_cred" UNIQUE ("store_id", "rp_id", "credential_id")
);--> statement-breakpoint
CREATE INDEX "customer_passkey_credential_customer" ON "customer_passkey_credential"("store_id", "customer_id");--> statement-breakpoint
ALTER TABLE "customer_passkey_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_passkey_credential" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_passkey_credential" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "customer_passkey_challenge" (
  "challenge_hash" text PRIMARY KEY,
  "store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('register','login','manage','grant')),
  "rp_id" text NOT NULL,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE CASCADE,
  "session_hash" text,
  "nonce_hash" text NOT NULL,
  "grant_source" text CHECK ("grant_source" IN ('password','passkey','mailbox')),
  "authorizing_credential_id" uuid REFERENCES "customer_passkey_credential"("id") ON DELETE CASCADE,
  "epoch" integer,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "customer_passkey_challenge_shape" CHECK (
    ("kind" = 'login' AND "customer_id" IS NULL AND "session_hash" IS NULL AND "grant_source" IS NULL AND "epoch" IS NULL) OR
    ("kind" IN ('register','manage') AND "customer_id" IS NOT NULL AND "session_hash" IS NOT NULL AND "grant_source" IS NULL AND "epoch" IS NOT NULL) OR
    ("kind" = 'grant' AND "customer_id" IS NOT NULL AND "session_hash" IS NOT NULL AND "grant_source" IS NOT NULL AND "epoch" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "customer_passkey_challenge_expires" ON "customer_passkey_challenge"("store_id", "expires_at");--> statement-breakpoint
ALTER TABLE "customer_passkey_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_passkey_challenge" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_passkey_challenge" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "customer_token" DROP CONSTRAINT IF EXISTS "customer_token_kind_check";--> statement-breakpoint
ALTER TABLE "customer_token" ADD CONSTRAINT "customer_token_kind_check" CHECK (kind IN ('password_reset', 'email_verify', 'set_password', 'email_change', 'magic_link', 'passkey_manage'));--> statement-breakpoint
CREATE FUNCTION admin_user_security_epoch() RETURNS trigger AS $$
DECLARE
  old_totp text := OLD.totp_secret;
  new_totp text := NEW.totp_secret;
  old_sealed boolean := old_totp LIKE 'enc1:%';
  new_sealed boolean := new_totp LIKE 'enc1:%';
  totp_changed boolean;
  password_changed boolean;
BEGIN
  -- A seal (plain -> enc1:) or unseal (enc1: -> plain) rewrites the representation of the same logical secret:
  -- totp-secret.ts only ever converts in place, and a 2FA enable refuses to overwrite an existing secret, so a
  -- cross-representation transition with both sides non-null is never a new secret.
  totp_changed := (old_totp IS DISTINCT FROM new_totp)
                  AND NOT (old_totp IS NOT NULL AND new_totp IS NOT NULL AND old_sealed <> new_sealed);
  password_changed := OLD.password_hash IS DISTINCT FROM NEW.password_hash;
  IF totp_changed THEN NEW.security_epoch := OLD.security_epoch + 1; END IF;
  IF totp_changed OR password_changed THEN
    UPDATE "session" SET step_up_at = NULL, step_up_epoch = NULL WHERE admin_user_id = OLD.id AND step_up_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "admin_user_security_epoch_trg" BEFORE UPDATE OF "totp_secret", "password_hash" ON "admin_user" FOR EACH ROW EXECUTE FUNCTION admin_user_security_epoch();--> statement-breakpoint
CREATE FUNCTION customer_security_epoch() RETURNS trigger AS $$
BEGIN
  -- The engine's verified in-place rehash sets app.passkey_rehash='1' for its transaction: same password, new
  -- representation, no bump. Every other password_hash write (reset, change, the previous image's rehash) bumps.
  IF OLD.password_hash IS DISTINCT FROM NEW.password_hash
     AND coalesce(current_setting('app.passkey_rehash', true), '') <> '1' THEN
    NEW.security_epoch := OLD.security_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "customer_security_epoch_trg" BEFORE UPDATE OF "password_hash" ON "customer" FOR EACH ROW EXECUTE FUNCTION customer_security_epoch();
-- DOWN (never run automatically): DROP TRIGGER customer_security_epoch_trg ON customer; DROP FUNCTION customer_security_epoch;
-- DROP TRIGGER admin_user_security_epoch_trg ON admin_user; DROP FUNCTION admin_user_security_epoch; DROP TABLE customer_passkey_challenge,
-- customer_passkey_credential, admin_passkey_challenge, admin_passkey_credential; ALTER TABLE session DROP COLUMN step_up_epoch;
-- ALTER TABLE customer DROP COLUMN security_epoch; ALTER TABLE admin_user DROP COLUMN security_epoch; restore the 0061 CHECK.
