-- Custom SQL migration file, put your code below! --

-- WP4a perf: back the storefront product search (name + description ILIKE) with
-- GIN trigram indexes so it stops sequential-scanning the product table on every
-- search. pg_trgm is a TRUSTED extension (PG13+), so the non-superuser DB owner
-- can install it; if the role lacks CREATE on the database, run
-- `CREATE EXTENSION pg_trgm;` once as a superuser before migrating.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS product_name_trgm_idx ON product USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_description_trgm_idx ON product USING gin (description gin_trgm_ops);
