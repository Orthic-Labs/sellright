CREATE TABLE IF NOT EXISTS "currency_rate" (
	"store_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"rate" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "currency_rate_store_id_currency_pk" PRIMARY KEY("store_id","currency")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "currency_rate" ADD CONSTRAINT "currency_rate_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "currency_rate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "currency_rate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "currency_rate" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
