-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- SEO-1: generic per-store SEO surface (sitemaps, robots.txt, JSON-LD,
-- IndexNow key-file) + cache-version. Neither `collection` nor `blog_post`
-- has ever tracked a mutation timestamp, and `stock` (availability) tracks
-- none either — sitemap <lastmod> and the cache-version endpoint both need
-- one. Rather than requiring every writer (admin-catalog-collections,
-- admin-content, import, restock, checkout) to remember to bump a counter,
-- a single generic BEFORE UPDATE trigger sets updated_at = now() on the row
-- itself, store-agnostic and independent of which code path performed the
-- write. drizzle-kit cannot express trigger functions (same class of gap as
-- 0049_restock_notify.sql), hence hand-written.

ALTER TABLE "collection" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "blog_post" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "blog_post" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "stock" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
	NEW.updated_at := now();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "collection_set_updated_at" BEFORE UPDATE ON "collection" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "blog_post_set_updated_at" BEFORE UPDATE ON "blog_post" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "stock_set_updated_at" BEFORE UPDATE ON "stock" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- product / product_variant already carry updated_at columns (migration 0000)
-- but no writer has ever bumped them (grep confirms no `.set({ updatedAt` /
-- raw `updated_at =` in admin-catalog.ts or admin-products.ts) — the columns
-- have silently frozen at insert time. Wiring the same trigger here is a
-- pure bugfix with no behavior for any existing reader to depend on wrongly.
CREATE TRIGGER "product_set_updated_at" BEFORE UPDATE ON "product" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "product_variant_set_updated_at" BEFORE UPDATE ON "product_variant" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- DOWN
-- DROP TRIGGER "product_variant_set_updated_at" ON "product_variant";
-- DROP TRIGGER "product_set_updated_at" ON "product";
-- DROP TRIGGER "stock_set_updated_at" ON "stock";
-- DROP TRIGGER "blog_post_set_updated_at" ON "blog_post";
-- DROP TRIGGER "collection_set_updated_at" ON "collection";
-- DROP FUNCTION set_updated_at();
-- ALTER TABLE "stock" DROP COLUMN "updated_at";
-- ALTER TABLE "blog_post" DROP COLUMN "updated_at";
-- ALTER TABLE "blog_post" DROP COLUMN "created_at";
-- ALTER TABLE "collection" DROP COLUMN "updated_at";
-- ALTER TABLE "collection" DROP COLUMN "created_at";
