-- WP9.5: provenance for the customer link (session | email_match) + future
-- freeform per-order keys (e.g. cart-token-before-conversion, marketing
-- attribution, etc.). Kept as a separate JSONB so a structured `linked_via`
-- query is indexable later if the email-match rate climbs.
--
-- RLS posture is unchanged (order is already FORCE-RLS'd) — this is additive.
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
