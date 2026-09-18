-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Waitlist parity (source review): a product-level Vendure waitlist signup is
-- imported as ONE subscriber row per variant topic (kind='waitlist',
-- topic='restock:<variantId>'). The restock claim consumes a row per topic, so
-- without a shared identity the same shopper would be emailed once per variant
-- restock — the source plugin sent a single notification per signup.
--
-- `signup_group` is that shared identity: every row expanded from one logical
-- signup carries the same value, and the restock claim consumes by group
-- (first variant restock sends the one email; sibling topics flip to
-- 'unsubscribed' in the same claim and can never re-mail). Rows with NULL
-- (native single-variant signups) are each their own consumption unit —
-- unchanged behavior.
ALTER TABLE "subscriber" ADD COLUMN IF NOT EXISTS "signup_group" text;--> statement-breakpoint
-- Backfill rows already imported from Vendure waitlists: meta.vendure.id is the
-- source waitlist_signup row id — shared across the expanded variant rows of
-- one logical signup, so it is exactly the group identity the importer now
-- stamps (as a migration-scoped id) on new imports.
UPDATE "subscriber" SET "signup_group" = meta->'vendure'->>'id'
  WHERE "kind" = 'waitlist' AND "source" = 'import'
    AND meta->'vendure'->>'id' IS NOT NULL AND "signup_group" IS NULL;--> statement-breakpoint
-- DOWN
-- ALTER TABLE "subscriber" DROP COLUMN "signup_group";
