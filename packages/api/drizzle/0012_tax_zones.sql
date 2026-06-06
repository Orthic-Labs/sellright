CREATE TABLE IF NOT EXISTS "tax_zone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"countries" text[] NOT NULL,
	"rate" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "tax_inclusive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_zone" ADD CONSTRAINT "tax_zone_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS (hand-added — drizzle-kit does not model row-level security). Hardened
-- nullif() form so a missing/empty store context fails closed to zero rows.
ALTER TABLE "tax_zone" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_zone" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_zone" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
