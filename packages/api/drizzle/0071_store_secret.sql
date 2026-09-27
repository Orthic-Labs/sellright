-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- WS-A (one-click install plan §1.6/§1.7): encrypted per-store settings.
-- Non-secret settings already live in store.config (JSONB); this table holds
-- ONLY owner-entered secrets (Stripe/NMI/Sezzle keys, SMTP password, ...),
-- each value sealed by packages/api/src/security/secret-crypto.ts before it
-- reaches this table — the API layer never writes plaintext here.
--
-- Hand-written because drizzle-kit cannot express FORCE ROW LEVEL SECURITY or
-- the tenant-isolation policy. Additive only — no existing table is touched.

CREATE TABLE IF NOT EXISTS "store_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"field" text NOT NULL,
	"key_version" integer NOT NULL,
	"iv" text NOT NULL,
	"ciphertext" text NOT NULL,
	"auth_tag" text NOT NULL,
	"last4" text,
	"metadata" jsonb,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_secret_provider_check" CHECK ("provider" IN ('stripe', 'nmi', 'sezzle', 'smtp')),
	CONSTRAINT "store_secret_scope_unique" UNIQUE ("store_id", "provider", "mode", "field")
);
--> statement-breakpoint
ALTER TABLE "store_secret" ADD CONSTRAINT "store_secret_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_secret_store_idx" ON "store_secret" USING btree ("store_id");--> statement-breakpoint

-- RLS (hand-added — drizzle-kit does not model row-level security).
ALTER TABLE "store_secret" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_secret" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "store_secret" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

-- DOWN
-- DROP TABLE "store_secret";
