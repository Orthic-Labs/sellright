ALTER TABLE "product" ADD COLUMN "vendor" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "product_type" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "seo_title" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "seo_description" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "metafields" jsonb;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "compare_at_price" integer;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "cost" integer;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "dimensions" jsonb;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "metafields" jsonb;