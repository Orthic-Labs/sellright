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
import { deliverWebhooks } from '../webhooks/emit.js';

const HOUR = 3_600_000;
const log = (m: string) => console.log(m);

/** Run `fn` now and on an interval; never let an overlap or a throw kill the loop. */
function every(ms: number, label: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return; // skip if the previous pass hasn't finished
    running = true;
    try { await fn(); } catch (e) { console.error(`[jobs] ${label} failed:`, e); } finally { running = false; }
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

  console.log(`[jobs] scheduler on — auto-deliver(apply=${autoDeliverApply}, days=${autoDeliverDays}) hourly; release-stale(apply=${releaseApply}, ttl=${releaseTtlMin}m) every 15m`);

  every(HOUR, 'auto-deliver', () => autoDeliver({ apply: autoDeliverApply, days: autoDeliverDays, log }));
  every(15 * 60_000, 'release-stale', () => releaseStaleAllocations({ apply: releaseApply, ttlMin: releaseTtlMin, log }));
  every(60_000, 'webhooks', () => deliverWebhooks({ log })); // push due webhook deliveries every minute
  // WP1.7 safety net: reset webhook_delivery rows stuck in 'processing' (a
  // crashed scheduler) back to 'pending' so the next pass re-claims them.
  // 10-min grace = a crashed worker is recovered within 15 min.
  const webhookReaperApply = env.JOBS_WEBHOOK_REAPER_APPLY === '1';
  const webhookReaperGraceMin = env.JOBS_WEBHOOK_REAPER_GRACE_MIN ?? 10;
  every(5 * 60_000, 'webhook-reaper', () => reapStuckWebhooks({ apply: webhookReaperApply, graceMin: webhookReaperGraceMin, log }));
}
