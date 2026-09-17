-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Affiliate automation gap (DD parity): DD's AffiliateOnboardingListener keys
-- affiliate onboarding off the promotion — a promotion carrying the affiliate's
-- email auto-creates the affiliate row, and a recipient change rotates the
-- dashboard token + resends the welcome mail. SellRight's promotion has no
-- name field to smuggle the email in (DD used Promotion.name), so the binding
-- gets an explicit nullable column instead. NULL = ordinary promotion.
--
-- NOTE: the drizzle schema lives in schema-core.ts (owned by another lane) and
-- deliberately does NOT declare this column yet — consumers read/write it via
-- raw sql`affiliate_email` refs (src/affiliate/onboarding.ts) until the schema
-- file catches up. Runtime queries don't need the drizzle table def.

ALTER TABLE "promotion" ADD COLUMN "affiliate_email" text;--> statement-breakpoint
-- Lookup for "promotions bound to an affiliate" scans (admin link endpoint).
CREATE INDEX "promotion_affiliate_email_idx" ON "promotion" ("store_id") WHERE "affiliate_email" IS NOT NULL;--> statement-breakpoint
-- DOWN
-- DROP INDEX "promotion_affiliate_email_idx";
-- ALTER TABLE "promotion" DROP COLUMN "affiliate_email";
