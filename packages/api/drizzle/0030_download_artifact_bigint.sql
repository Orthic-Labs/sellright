-- Custom SQL migration file, put your code below! --

-- download_artifact.size_bytes was int4 (caps at ~2 GB). Software downloads
-- (installers, app/game bundles) routinely exceed that — widen to bigint.
-- int4 → int8 is an implicit, lossless widening (no USING / table rewrite risk).
ALTER TABLE download_artifact ALTER COLUMN size_bytes TYPE bigint;
