-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
-- Same drift reason as 0072-0076: `drizzle-kit generate` against this
-- checkout's stale meta snapshot recomputes a bogus diff that tries to
-- re-CREATE TABLE for a dozen tables (subscription, storekit_*, loyalty_ledger,
-- payment_attempt, ...) that already exist in every real database via their
-- own hand-written migrations. Verified by running `db:generate` once,
-- inspecting the output (it emitted CREATE TABLE for already-live tables),
-- and discarding it in favor of this hand-authored file, which carries ONLY
-- the three genuinely new, additive columns for the admin-essentials work
-- (partial fulfillment location/notify + stock-adjustment actor).
--
-- Expand-only (docs/runbooks/migrations.md "Expand/contract policy"): every
-- column here is nullable or has a default, so the previous release's INSERTs
-- keep working unmodified against the new shape.
ALTER TABLE "fulfillment" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "fulfillment" ADD COLUMN "notify_customer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfillment" ADD CONSTRAINT "fulfillment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Append-only adjustment ledger: who made this stock movement. Nullable so
-- historical rows (and any call site not yet updated) remain valid; new
-- admin-initiated adjustments always set it (admin.email) going forward.
ALTER TABLE "stock_movement" ADD COLUMN "actor" text;
-- DOWN
-- ALTER TABLE "stock_movement" DROP COLUMN "actor";
-- ALTER TABLE "fulfillment" DROP CONSTRAINT "fulfillment_location_id_location_id_fk";
-- ALTER TABLE "fulfillment" DROP COLUMN "notify_customer";
-- ALTER TABLE "fulfillment" DROP COLUMN "location_id";
