-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- API-H1: durable queue for Cloudflare edge purges triggered by blog, collection and store-config edits
-- (cache/purge-queue.ts). Those purges were fire-and-forget with an in-memory retry, so a Cloudflare outage or an API
-- restart in the retry window left the edge serving the old page for its whole s-maxage (3600 s). A row is written in the
-- same transaction as the edit (or right after commit for callers without a transaction); the immediate attempt deletes
-- it on success; the cache-purge-drain job retries due rows with backoff and marks a row `dead` after 10 failed rounds
-- (plus the existing cache_purge_failed alert log).
-- RLS: none, the same posture as catalog_manifest_pending (0079): a global infra table. It carries store_id so the
-- cross-store drain job can work without a store context, holds URLs only, and is listed in db/assert-force-rls.ts and
-- db/rls-tables.test.ts as exempt. Runtime grants follow schema-owner default privileges. Additive: the previous image
-- never reads it. Tiny (rows live minutes; dead rows are dropped after 30 days).
CREATE TABLE IF NOT EXISTS "edge_purge_pending" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "store_slug" text NOT NULL,
  "event" text NOT NULL,
  "spec" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'dead')),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edge_purge_pending_due_idx" ON "edge_purge_pending" ("next_attempt_at", "id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edge_purge_pending_dead_idx" ON "edge_purge_pending" ("created_at") WHERE "status" = 'dead';
-- DOWN (never run automatically): DROP TABLE IF EXISTS edge_purge_pending; (the previous image never reads it; pending purges are lost, the TTL covers them).
