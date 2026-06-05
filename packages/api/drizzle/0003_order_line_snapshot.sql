ALTER TABLE "order_line" ALTER COLUMN "variant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "variant_sku" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "variant_name" text NOT NULL;