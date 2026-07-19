-- HAND-WRITTEN: see docs/runbooks/migrations.md
-- Queue rows are updated for claim, retry, and final delivery. Lower thresholds
-- keep dead tuples from accumulating between the default 20%-scale vacuums.
ALTER TABLE "email_outbox" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50
);--> statement-breakpoint
ALTER TABLE "push_outbox" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50
);
