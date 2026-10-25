-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Saved admin accounts (#355, phase 1): the target side of the hub sign-in handoff. A signed-in admin on THIS server
-- asks for a one-use code for one registered hub client (POST /v1/admin/handoff/authorize); the hub redeems it once,
-- server to server, with its client secret and PKCE verifier (POST /v1/admin/handoff/token) for a new session of the
-- same admin. Only sha256(code) is stored. Each code is bound to the client, its exact callback, the PKCE S256
-- challenge, the issuing session and the admin's security epoch, and lives 60 seconds.
-- Global like admin_auth_challenge (resolved before any store context; no store_id, so no RLS).
-- Additive: the previous image never reads the table. Runtime grants follow schema-owner default privileges.
CREATE TABLE "admin_handoff_code" (
  "code_hash" text PRIMARY KEY,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "epoch" integer NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "admin_handoff_code_expires" ON "admin_handoff_code"("expires_at");--> statement-breakpoint
-- A session minted by a redemption names its client. Such a session proved no credential itself, so it never counts
-- as freshly signed in (no further handoff, no first-factor enrolment without the password); NULL = a real sign-in.
ALTER TABLE "session" ADD COLUMN "handoff_client_id" text;
-- DOWN (never run automatically): DROP TABLE "admin_handoff_code"; ALTER TABLE "session" DROP COLUMN "handoff_client_id"
-- (the previous image reads neither; it would treat a hub session as an ordinary one, so roll back only with the hub off).
