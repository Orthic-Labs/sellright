/**
 * Minimal in-process job scheduler (setInterval — no Redis/BullMQ for these two
 * housekeeping passes). DISABLED BY DEFAULT and fail-safe:
 *
 *   JOBS_ENABLED=1                  master switch (default off → no-op)
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
 * Runs as the OWNER role (jobs set their own per-store context). Only call this
 * from a process that owns the DB pool (the API server), never from tests.
 */
import { env } from '../env.js';
import { autoDeliver } from './auto-deliver.js';
import { releaseStaleAllocations } from './release-stale-allocations.js';
import { reapStuckWebhooks } from './webhook-reaper.js';
import { abandonStaleCarts, cleanupExpiredCarts } from './cart-maintenance.js';
import { deliverWebhooks } from '../webhooks/emit.js';
import { withLeaderLock, type LeaderLockedJob } from './leader-lock.js';

const HOUR = 3_600_000;
const log = (m: string) => console.log(m);

/**
 * Run `fn` now and on an interval; never let an overlap or a throw kill the
 * loop. `running` only guards overlap WITHIN this process — it does nothing
 * for a second API instance running the same interval. `leaderJob` wraps the
 * pass in a cross-process Postgres advisory lock (see leader-lock.ts) so only
 * one instance actually executes a given tick; the rest see the lock held and
 * skip, cheaply, without racing the DB.
 */
function every(ms: number, label: string, leaderJob: LeaderLockedJob, fn: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return; // skip if the previous pass hasn't finished (this process)
    running = true;
    try {
      await withLeaderLock(leaderJob, fn); // skip if another instance is leader for this tick
    } catch (e) {
      console.error('[jobs] failed:', label, e);
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
    console.log('[jobs] scheduler disabled (set JOBS_ENABLED=1 to enable)');
    return;
  }
  const autoDeliverApply = env.JOBS_AUTO_DELIVER_APPLY === '1';
  const autoDeliverDays = env.JOBS_AUTO_DELIVER_DAYS ?? 10;
  const releaseApply = env.JOBS_RELEASE_STALE_APPLY === '1';
  const releaseTtlMin = env.JOBS_RELEASE_STALE_TTL_MIN ?? 60;

  console.log(`[jobs] scheduler on — auto-deliver(apply=${autoDeliverApply}, days=${autoDeliverDays}) hourly; release-stale(apply=${releaseApply}, ttl=${releaseTtlMin}m) every 15m; cart-maintenance(abandon=${env.CART_ABANDON_HOURS}h, ttl=${env.CART_TTL_DAYS}d) every 15m`);

  every(HOUR, 'auto-deliver', 'auto-deliver', () => autoDeliver({ apply: autoDeliverApply, days: autoDeliverDays, log }));
  every(15 * 60_000, 'release-stale', 'release-stale', () => releaseStaleAllocations({ apply: releaseApply, ttlMin: releaseTtlMin, log }));
  // Cart lifecycle: flag inactive non-empty carts abandoned (emits cart.abandoned
  // for recovery) + hard-delete idle/empty carts past their TTL. Always applies
  // (no dry-run flag): abandonment is reversible (a returning shopper re-activates
  // the cart on the next mutation) and cleanup only removes empty active carts.
  every(15 * 60_000, 'cart-maintenance', 'cart-maintenance', async () => {
    const ab = await abandonStaleCarts(env.CART_ABANDON_HOURS);
    const cl = await cleanupExpiredCarts();
    if (ab.abandoned || cl.deleted) log(`[jobs:cart] abandoned=${ab.abandoned} purged=${cl.deleted}`);
  });
  every(60_000, 'webhooks', 'webhooks', () => deliverWebhooks({ log })); // push due webhook deliveries every minute
  // WP1.7 safety net: reset webhook_delivery rows stuck in 'processing' (a
  // crashed scheduler) back to 'pending' so the next pass re-claims them.
  // 10-min grace = a crashed worker is recovered within 15 min.
  const webhookReaperApply = env.JOBS_WEBHOOK_REAPER_APPLY === '1';
  const webhookReaperGraceMin = env.JOBS_WEBHOOK_REAPER_GRACE_MIN ?? 10;
  every(5 * 60_000, 'webhook-reaper', 'webhook-reaper', () => reapStuckWebhooks({ apply: webhookReaperApply, graceMin: webhookReaperGraceMin, log }));
}
