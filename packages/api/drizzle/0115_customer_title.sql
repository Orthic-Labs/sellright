-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- #393: the customer's title (Mr, Ms, Dr, ...), which the storefront account profile edits and the previous platform
-- stored. Nullable text, no default: additive; the previous image never reads it.
ALTER TABLE "customer" ADD COLUMN "title" text;
-- DOWN (never run automatically): ALTER TABLE "customer" DROP COLUMN "title" (the previous image never reads it).
