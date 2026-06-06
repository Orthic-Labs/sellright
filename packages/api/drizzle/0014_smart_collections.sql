ALTER TABLE "collection" ADD COLUMN "rules" jsonb;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "image_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "seo_title" text;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "seo_description" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection" ADD CONSTRAINT "collection_image_asset_id_asset_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
