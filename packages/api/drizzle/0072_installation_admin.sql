-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- WS-B (one-click install plan §1.3/§1.4): installation-admin authority +
-- claim token. Hand-written because this repo's drizzle-kit snapshot history
-- has already drifted from several earlier hand-written migrations (0053+),
-- so `drizzle-kit generate` recomputes a bogus diff that re-adds columns and
-- constraints that already exist in every real database. Additive only — no
-- existing table/column/constraint is touched beyond the new
-- admin_user.is_installation_admin column.

ALTER TABLE "admin_user" ADD COLUMN IF NOT EXISTS "is_installation_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_user" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint

-- DB-level backstop (belt-and-suspenders alongside the atomic token UPDATE in
-- claimInstallation()): at most one admin_user can ever hold install-wide
-- authority. A partial unique index — not expressible by drizzle-kit, same
-- gap class as license_activation_token_hash (0027) / store_secret_scope
-- (0071) — so even a bug that lets two transactions both pass the token
-- check can never leave two installation admins committed.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_user_installation_admin_unique"
	ON "admin_user" ("is_installation_admin")
	WHERE "is_installation_admin" = true;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "setup_claim_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_claim_token_token_hash_unique" UNIQUE("token_hash")
);
-- No store_id column — global/pre-auth table, same isolation model as
-- staff_invite (256-bit token hash, not RLS). Not added to the RLS EXEMPT
-- set because assert-force-rls only scans tables that HAVE a store_id column.

-- DOWN
-- DROP TABLE "setup_claim_token";
-- ALTER TABLE "admin_user" DROP COLUMN "is_installation_admin";
