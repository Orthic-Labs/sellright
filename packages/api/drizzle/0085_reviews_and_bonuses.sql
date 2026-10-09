-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- REWARDS-1: product reviews + bonus earn rules.
--
-- Hand-written because drizzle-kit cannot express: swapping the CHECK
-- constraints on loyalty_ledger (kind set + per-kind sign), partial unique
-- indexes, or the FORCE RLS tenant policy at the right ordinal — and this
-- checkout's drizzle snapshot history has already drifted (see 0072-0082).
--
--  * loyalty_ledger gains the 'bonus' kind (always a credit). Every bonus
--    posting carries a deterministic source_ref (bonus:review:<id>,
--    bonus:signup:<customer>, bonus:first_order:<customer>,
--    bonus:birthday:<customer>:<year>) so a trigger can only ever pay once.
--    An admin reversal is an ordinary 'reverse' row (any sign) and never
--    clears the original source_ref, so a reversed bonus cannot re-grant.
--  * customer gains birth_month / birth_day (no year: the program only needs
--    the anniversary, and a year of birth is data we do not need to hold).
--  * product_review: one row per review, moderated (pending -> approved /
--    rejected). One review per product per reviewer email (partial unique
--    index). bonus_ledger_id records the granted bonus for display/audit.
--
-- Additive except the two ledger constraints, which are widened (every
-- existing row still satisfies the new ones).

ALTER TABLE "loyalty_ledger" DROP CONSTRAINT IF EXISTS "loyalty_ledger_kind_check";--> statement-breakpoint
ALTER TABLE "loyalty_ledger" DROP CONSTRAINT IF EXISTS "loyalty_ledger_sign_check";--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_kind_check" CHECK ("kind" IN ('earn', 'redeem', 'reverse', 'adjust', 'expire', 'import', 'bonus'));--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_sign_check" CHECK (
	("kind" IN ('earn', 'import', 'bonus') AND "points" >= 0)
	OR ("kind" IN ('redeem', 'expire') AND "points" <= 0)
	OR ("kind" IN ('reverse', 'adjust'))
);--> statement-breakpoint

ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "birth_month" smallint;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "birth_day" smallint;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_birthday_check" CHECK (
	("birth_month" IS NULL AND "birth_day" IS NULL)
	OR ("birth_month" BETWEEN 1 AND 12 AND "birth_day" BETWEEN 1 AND 31)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "product_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_id" uuid,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"rating" smallint NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_buyer" boolean DEFAULT false NOT NULL,
	"reply" text,
	"replied_at" timestamp with time zone,
	"bonus_points" integer DEFAULT 0 NOT NULL,
	"moderated_by" text,
	"moderated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_review_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
	CONSTRAINT "product_review_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "product_review_bonus_check" CHECK ("bonus_points" >= 0)
);--> statement-breakpoint
ALTER TABLE "product_review" ADD CONSTRAINT "product_review_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_review" ADD CONSTRAINT "product_review_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_review" ADD CONSTRAINT "product_review_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Public listing + aggregate hot path: approved reviews of one product, newest first.
CREATE INDEX IF NOT EXISTS "product_review_product_idx" ON "product_review" USING btree ("store_id", "product_id", "created_at" DESC) WHERE "status" = 'approved';--> statement-breakpoint
-- Moderation queue.
CREATE INDEX IF NOT EXISTS "product_review_status_idx" ON "product_review" USING btree ("store_id", "status", "created_at" DESC);--> statement-breakpoint
-- One review per product per reviewer (normalized email).
CREATE UNIQUE INDEX IF NOT EXISTS "product_review_one_per_reviewer" ON "product_review" USING btree ("store_id", "product_id", "author_email");--> statement-breakpoint

ALTER TABLE "product_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "product_review" USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid) WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);

-- DOWN
-- DROP TABLE "product_review";
-- ALTER TABLE "customer" DROP CONSTRAINT "customer_birthday_check", DROP COLUMN "birth_month", DROP COLUMN "birth_day";
-- (loyalty_ledger: delete 'bonus' rows, then restore the 0070 constraints)
