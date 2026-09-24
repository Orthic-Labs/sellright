/**
 * Minimal in-process job scheduler (setInterval — no Redis/BullMQ for these two
 * housekeeping passes). DISABLED BY DEFAULT and fail-safe:
 *
 *   JOBS_ENABLED=1                  master switch (default off → no-op)
 *   JOBS_PUSH_ENABLED=1             deliver queued APNs pushes (default off)
 *   JOBS_AUTO_DELIVER_APPLY=1       actually transition (default: dry-run log)
 *   JOBS_AUTO_DELIVER_DAYS=10       Shipped→Delivered age threshold
 *   JOBS_RELEASE_STALE_APPLY=1      actually cancel + release (default: dry-run)
 *   JOBS_RELEASE_STALE_TTL_MIN=60   unpaid-order age threshold (minutes)
 *
 * ⚠ release-stale APPLY mass-cancels old PendingPayment orders. DD's imported
 * catalog has thousands of historical PendingPayment rows that are NOT abandoned
 * carts — never enable JOBS_RELEASE_STALE_APPLY against that data without first
 * confirming the cutoff only catches orders from the new checkout flow. Apply is
 * off by default for exactly this reason; the scheduler logs a dry-run instead.
 *
 * Runs as the unprivileged runtime role (jobs set their own store context). Only call this
 * from a process that owns the DB pool (the API server), never from tests.
 */
import { env } from '../env.js';
import { autoDeliver } from './auto-deliver.js';
import { releaseStaleAllocations } from './release-stale-allocations.js';
import { reconcileGatewayEvents } from './reconcile-gateway-events.js';
import { reapStuckWebhooks } from './webhook-reaper.js';
import { reapProcessedEvents } from './processed-event-reaper.js';
import { abandonStaleCarts, cleanupExpiredCarts } from './cart-maintenance.js';
import { deliverWebhooks } from '../webhooks/emit.js';
import { deliverEmails } from '../email/outbox.js';
import { deliverPushes } from '../push/outbox.js';
import { listmonkSync } from './listmonk-sync.js';
import { sheeridExpirySweep } from './sheerid-expiry.js';
import { sweepRestockEvents } from '../routes/restock.js';
import { withLeaderLock, type LeaderLockedJob } from './leader-lock.js';
import { log, err as logErr } from '../lib/logger.js';
import { publishCatalogManifest } from '../manifest/catalog.js';

const HOUR = 3_600_000;
// OBS-1: job-level log line passes through the structured logger so it carries
// the same shape as the per-request logs and stays greppable by job label.
const jobLog = (m: string) => log.info(m);

/**
 * Run `fn` now and on an interval; never let an overlap or a throw kill the
 * loop. `running` only guards overlap WITHIN this process — it does nothing
 * for a second API instance running the same interval. `leaderJob` wraps the
 * pass in a cross-process Postgres advisory lock (see leader-lock.ts) so only
 * one instance actually executes a given tick; the rest see the lock held and
 * skip, cheaply, without racing the DB.
 */
function every(ms: number, label: string, leaderJob: LeaderLockedJob, fn: () => Promise<unknown>, scope?: string): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return; // skip if the previous pass hasn't finished (this process)
    running = true;
    try {
      await withLeaderLock(leaderJob, fn, scope); // skip if another instance is leader for this tick
    } catch (e) {
      logErr.error('job failed', e, { job: label });
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, ms);
  t.unref?.(); // don't keep the event loop alive just for the scheduler
  void tick(); // kick once at startup
  return t;
}

export function startJobScheduler(): void {
  if (env.JOBS_ENABLED !== '1' || env.NODE_ENV === 'test') {
    log.info('scheduler disabled', { hint: 'set JOBS_ENABLED=1 to enable' });
    return;
  }
  const autoDeliverApply = env.JOBS_AUTO_DELIVER_APPLY === '1';
  const autoDeliverDays = env.JOBS_AUTO_DELIVER_DAYS ?? 10;
  const releaseApply = env.JOBS_RELEASE_STALE_APPLY === '1';
  const releaseTtlMin = env.JOBS_RELEASE_STALE_TTL_MIN ?? 60;

  log.info('scheduler on', {
    autoDeliverApply,
    autoDeliverDays,
    releaseApply,
    releaseTtlMin,
    cartAbandonHours: env.CART_ABANDON_HOURS,
    cartTtlDays: env.CART_TTL_DAYS,
    cartRetentionDays: env.CART_RETENTION_DAYS,
  });

  every(60_000, 'gateway-events', 'gateway-events', reconcileGatewayEvents);
  // Stock is never cached/polled (locked invariant): the catalog manifest used
  // to regenerate on a 60s interval, which meant a stock change could sit
  // stale for up to a minute. It now regenerates IMMEDIATELY from
  // manifest/stock-hook.ts's onStockChanged(), called after every
  // stock-mutating transaction commits (reservation, release, refund restock,
  // admin stock edit, ...). All that's left here is a one-shot publish at
  // startup so the manifest exists before the first stock event ever fires.
  if (env.CATALOG_MANIFEST_JOBS_ENABLED === '1') {
    if (!env.CATALOG_DIR?.trim() || !env.STORE_SLUG?.trim()) {
      log.info('catalog publisher disabled: explicit CATALOG_DIR and STORE_SLUG required');
    } else {
      void withLeaderLock('catalog-manifest', () => publishCatalogManifest({ outDir: env.CATALOG_DIR!, storeSlug: env.STORE_SLUG! }), env.STORE_SLUG)
        .catch((e) => logErr.error('startup catalog publish failed', e, { job: 'catalog-manifest' }));
    }
  }
  every(HOUR, 'auto-deliver', 'auto-deliver', () => autoDeliver({ apply: autoDeliverApply, days: autoDeliverDays, log: jobLog }));
  every(15 * 60_000, 'release-stale', 'release-stale', () => releaseStaleAllocations({ apply: releaseApply, ttlMin: releaseTtlMin, log: jobLog }));
  // Cart lifecycle: flag inactive non-empty carts abandoned (emits cart.abandoned
  // for recovery) + hard-delete idle/empty carts past their TTL. Always applies
  // (no dry-run flag): abandonment is reversible (a returning shopper re-activates
  // the cart on the next mutation) and cleanup only removes empty active carts.
  every(15 * 60_000, 'cart-maintenance', 'cart-maintenance', async () => {
    const ab = await abandonStaleCarts(env.CART_ABANDON_HOURS);
    const cl = await cleanupExpiredCarts();
    if (ab.abandoned || cl.deleted) jobLog(`[jobs:cart] abandoned=${ab.abandoned} purged=${cl.deleted}`);
  });
  every(60_000, 'webhooks', 'webhooks', () => deliverWebhooks({ log: jobLog })); // push due webhook deliveries every minute
  // REL-4: push due email_outbox rows every minute — retry/dead-letter the
  // order-confirmation path. Mirrors the webhook claim pattern (FOR UPDATE
  // SKIP LOCKED, exponential backoff, dead-letter after MAX_ATTEMPTS).
  every(60_000, 'emails', 'emails', () => deliverEmails({ log: jobLog }));
  // Mobile push (0039): same cadence + claim pattern as emails. Gated on its own
  // switch so a deployment can queue pushes before the APNs key exists — the
  // outbox fills either way and drains when this flips on. deliverPushes also
  // self-no-ops when APNS_* is unconfigured, so this is belt-and-braces.
  if (env.JOBS_PUSH_ENABLED === '1') {
    every(60_000, 'push', 'push', () => deliverPushes({}));
  }
  // SUBSCRIBER-1: push confirmed + unsynced subscribers to Listmonk every 5
  // minutes. Slower than email/webhook because it's a best-effort downstream
  // sync, not a real-time deliverability path — a 5-min lag is fine, and the
  // smaller cadence costs less when a store has hundreds of thousands of
  // subscribers (Listmonk's /api/subscribers is rate-limited upstream).
  every(5 * 60_000, 'listmonk-sync', 'listmonk-sync', () => listmonkSync({ log: jobLog }));
  // PAR-4: flip stale 'success' SheerID rows to 'expired' and recompute the
  // customers' active_verifications — drops verified_customer coupon
  // eligibility for lapsed verifications. Hourly: expiry granularity is days.
  every(HOUR, 'sheerid-expiry', 'sheerid-expiry', () => sheeridExpirySweep({ log: jobLog }));
  // PAR-5: the stock trigger queues restock_event rows on <=0→>0 transitions;
  // this drains them into one-shot customer notifications (claim inside the
  // txn — crash-safe, no double-notify).
  every(60_000, 'restock-notify', 'restock-notify', async () => {
    const r = await sweepRestockEvents();
    if (r.events || r.notified) jobLog(`[jobs:restock] events=${r.events} notified=${r.notified}`);
  });
  // WP1.7 safety net: reset webhook_delivery rows stuck in 'processing' (a
  // crashed scheduler) back to 'pending' so the next pass re-claims them.
  // 10-min grace = a crashed worker is recovered within 15 min.
  const webhookReaperApply = env.JOBS_WEBHOOK_REAPER_APPLY === '1';
  const webhookReaperGraceMin = env.JOBS_WEBHOOK_REAPER_GRACE_MIN ?? 10;
  every(5 * 60_000, 'webhook-reaper', 'webhook-reaper', () => reapStuckWebhooks({ apply: webhookReaperApply, graceMin: webhookReaperGraceMin, log: jobLog }));
  // processed_event never had a reaper — it gets one row per Stripe webhook id
  // plus one per payment idempotency claim and neither writer ever deletes it,
  // so the table grows forever. Retention defaults to 30 days, well past any
  // realistic idempotency/replay window. Runs hourly (this table is low-churn
  // compared to webhooks/emails, so a tighter cadence isn't needed).
  const processedEventReaperApply = env.JOBS_PROCESSED_EVENT_REAPER_APPLY === '1';
  const processedEventReaperRetentionDays = env.JOBS_PROCESSED_EVENT_REAPER_RETENTION_DAYS ?? 30;
  every(HOUR, 'processed-event-reaper', 'processed-event-reaper', () =>
    reapProcessedEvents({ apply: processedEventReaperApply, retentionDays: processedEventReaperRetentionDays, log: jobLog }));
}
