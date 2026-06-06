CREATE TYPE "public"."return_status" AS ENUM('requested', 'approved', 'rejected', 'received', 'refunded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"restock" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "return_status" DEFAULT 'requested' NOT NULL,
	"reason" text,
	"refund_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_line" ADD CONSTRAINT "return_line_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_line" ADD CONSTRAINT "return_line_return_id_return_request_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_request"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_line" ADD CONSTRAINT "return_line_order_line_id_order_line_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_request" ADD CONSTRAINT "return_request_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_request" ADD CONSTRAINT "return_request_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS (hand-added — drizzle-kit does not model row-level security).
ALTER TABLE "return_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "return_request" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "return_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "return_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "return_line" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);
