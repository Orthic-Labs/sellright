-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- 0094: automation agent seats (docs/plans/2026-10-10-agent-role-v5.md).
--  (1) admin_user.kind marks agent identities: no password, TOTP, invite or magic link, ever.
--      Agents hold an ORDINARY admin_user_store role (staff/manager/read_only — never owner); the only
--      agent-specific limit is the deny set in src/auth/agent-policy.ts, enforced by middleware.
--  (2) admin_api_token: long-lived hashed credentials resolved by requireAdmin for 'sra_' bearers.
--      Registry table like session / admin_user_store: resolved before any store context, so it is
--      deliberately RLS-EXEMPT (src/db/assert-force-rls.ts); isolation is the 256-bit hash joined to
--      its single (admin_user_id, store_id) grant on every request.
--  (3) session.api_token_id binds an agent's browser session to the token that minted it; the unique
--      partial index makes "one live browser session per token" a database invariant
--      (protected from spurious drops by scripts/assert-no-partial-index-drop.mjs).
ALTER TABLE "admin_user" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'human';--> statement-breakpoint
ALTER TABLE "admin_user" DROP CONSTRAINT IF EXISTS "admin_user_kind_check";--> statement-breakpoint
ALTER TABLE "admin_user" ADD CONSTRAINT "admin_user_kind_check" CHECK ("kind" IN ('human', 'agent'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_api_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE cascade,
	"store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_api_token_user_store_idx" ON "admin_api_token" ("admin_user_id", "store_id");--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "api_token_id" uuid REFERENCES "admin_api_token"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_api_token_unique" ON "session" ("api_token_id") WHERE "api_token_id" IS NOT NULL;

-- DOWN (manual):
-- ALTER TABLE "session" DROP COLUMN "api_token_id";
-- DROP TABLE "admin_api_token";
-- ALTER TABLE "admin_user" DROP CONSTRAINT "admin_user_kind_check"; ALTER TABLE "admin_user" DROP COLUMN "kind";
