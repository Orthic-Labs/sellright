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
import { isMaintenanceOn } from '../maintenance.js';
import { autoDeliver } from './auto-deliver.js';
import { releaseStaleAllocations } from './release-stale-allocations.js';
import { reconcileGatewayEvents } from './reconcile-gateway-events.js';
import { recoverGatewayAttempts } from './gateway-recovery.js';
import { reapStuckWebhooks } from './webhook-reaper.js';
import { reapProcessedEvents } from './processed-event-reaper.js';
import { abandonStaleCarts, cleanupExpiredCarts } from './cart-maintenance.js';
import { deliverWebhooks } from '../webhooks/emit.js';
import { deliverEmails } from '../email/outbox.js';
import { deliverPushes } from '../push/outbox.js';
import { listmonkSync } from './listmonk-sync.js';
import { sheeridExpirySweep } from './sheerid-expiry.js';
import { birthdayBonusSweep } from './birthday-bonus.js';
import { sweepRestockEvents } from '../routes/restock.js';
import { withLeaderLock, type LeaderLockedJob } from './leader-lock.js';
import { log, err as logErr } from '../lib/logger.js';
import { publishCatalogManifest } from '../manifest/catalog.js';
import { loadStalePendingManifestRegenerations, clearManifestRegenerationPending } from '../manifest/manifest-pending.js';
import { reapRateLimitAttempts } from '../auth/rate-limit-backend.js';

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
interface SchedulerState {
  stopped: boolean;
  timers: Set<NodeJS.Timeout>;
  inflight: Set<Promise<void>>;
  /** Names of every job registered this run (engine + plugin) — diagnostics for effective-config. */
  names: string[];
}

function every(state: SchedulerState, ms: number, label: string, leaderJob: LeaderLockedJob, fn: () => Promise<unknown>, scope?: string): NodeJS.Timeout {
  state.names.push(label);
  let running = false;
  const tick = async () => {
    if (state.stopped) return; // shutdown step 2: no new passes after stop()
    if (running) return; // skip if the previous pass hasn't finished (this process)
    // WS-E: pause every scheduled pass during an appliance update. The update
    // sequence flips maintenance on before backup/migrate — a job racing a
    // schema mid-migration (or writing rows during the functional-check dry
    // run) is exactly the class of bug maintenance mode exists to prevent.
    if (isMaintenanceOn()) return;
    running = true;
    const pass = (async () => {
      try {
        await withLeaderLock(leaderJob, fn, scope); // skip if another instance is leader for this tick
      } catch (e) {
        logErr.error('job failed', e, { job: label });
      } finally {
        running = false;
      }
    })();
    state.inflight.add(pass);
    void pass.finally(() => state.inflight.delete(pass));
    await pass;
  };
  const t = setInterval(tick, ms);
  state.timers.add(t);
  t.unref?.(); // don't keep the event loop alive just for the scheduler
  // Kick once at startup, staggered: every leader-locked pass holds two pooled
  // connections (advisory lock + work), so firing all jobs in the same tick
  // exhausted the pool on boot — requests and readiness probes timed out
  // waiting for a connection until the first passes finished.
  const kick = setTimeout(() => void tick(), state.names.length === 0 ? 0 : (state.names.length - 1) * STARTUP_STAGGER_MS);
  state.timers.add(kick);
  kick.unref?.();
  return t;
}

/** Gap between the startup passes of consecutive jobs (see every()). */
export const STARTUP_STAGGER_MS = 750;

/** A job contributed by a plugin's `jobs` lifecycle phase. */
export interface PluginJob {
  /** Unique within the plugin; the leader-lock key is `plugin:<plugin>:<name>`. */
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface JobScheduler {
  /** True when jobs are actually running (JOBS_ENABLED=1 and not NODE_ENV=test). */
  readonly enabled: boolean;
  /** Registered job labels (engine + plugin). Empty when disabled. */
  readonly jobs: readonly string[];
  /** Shutdown step 2: cancel every timer and wait (bounded) for in-flight passes. */
  stop(timeoutMs?: number): Promise<void>;
}

const DISABLED: JobScheduler = { enabled: false, jobs: [], stop: async () => undefined };

export function startJobScheduler(extraJobs: ReadonlyArray<PluginJob & { plugin: string }> = []): JobScheduler {
  if (env.JOBS_ENABLED !== '1' || env.NODE_ENV === 'test') {
    log.info('scheduler disabled', { hint: 'set JOBS_ENABLED=1 to enable' });
    return DISABLED;
  }
  const state: SchedulerState = { stopped: false, timers: new Set(), inflight: new Set(), names: [] };
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

  every(state, 60_000, 'gateway-events', 'gateway-events', reconcileGatewayEvents);
  // D7/D8: stuck NMI/Sezzle attempts (processing/unknown/pending) are
  // auto-verified with backoff; unapproved Sezzle sessions expire, approved
  // ones capture (order still payable) or release. Applies by default like
  // gateway-events — every action goes through the authoritative provider read.
  const gatewayRecoveryApply = env.JOBS_GATEWAY_RECOVERY_APPLY !== '0';
  every(state, 5 * 60_000, 'gateway-recovery', 'gateway-recovery', () => recoverGatewayAttempts({
    apply: gatewayRecoveryApply,
    ageMin: env.JOBS_GATEWAY_RECOVERY_AGE_MIN ?? 15,
    sezzleSessionExpiryMin: env.SEZZLE_SESSION_EXPIRY_MIN ?? 180,
    maxAttempts: env.JOBS_GATEWAY_RECOVERY_MAX_ATTEMPTS ?? 10,
    backoffBaseMin: 5,
    log: jobLog,
  }));
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
      // SELLRIGHT-ISSUES P1: durable-retry drain. onStockChanged's in-process
      // trailing-rerun state (stock-hook.ts) doesn't survive a crash between
      // "stock changed" and "manifest republished" — catalog_manifest_pending
      // (migration 0079) is the durable trace of that gap. Anything stale
      // enough to prove its in-process attempt never finished gets a full
      // regen here and its marker cleared. 90s stale threshold: a healthy
      // run — even a full-catalog one — clears its own marker in well under
      // that; this is a crash-recovery net, not a normal-path cadence.
      every(state, 2 * 60_000, 'catalog-manifest-drain', 'catalog-manifest-drain', async () => {
        const stale = await loadStalePendingManifestRegenerations(90_000);
        for (const p of stale) {
          if (p.storeSlug !== env.STORE_SLUG) continue; // this deployment only publishes its own store
          try {
            await withLeaderLock('catalog-manifest', () => publishCatalogManifest({ outDir: env.CATALOG_DIR!, storeSlug: p.storeSlug }), p.storeSlug);
            await clearManifestRegenerationPending(p.storeId);
            jobLog(`[jobs:catalog-manifest-drain] recovered a lost regeneration for ${p.storeSlug} (pending since ${p.requestedAt.toISOString()})`);
          } catch (e) {
            logErr.error('catalog-manifest-drain retry failed — marker left in place for the next pass', e, { storeSlug: p.storeSlug });
          }
        }
      });
    }
  }
  every(state, HOUR, 'auto-deliver', 'auto-deliver', () => autoDeliver({ apply: autoDeliverApply, days: autoDeliverDays, log: jobLog }));
  every(state, 15 * 60_000, 'release-stale', 'release-stale', () => releaseStaleAllocations({ apply: releaseApply, ttlMin: releaseTtlMin, log: jobLog }));
  // Cart lifecycle: flag inactive non-empty carts abandoned (emits cart.abandoned
  // for recovery) + hard-delete idle/empty carts past their TTL. Always applies
  // (no dry-run flag): abandonment is reversible (a returning shopper re-activates
  // the cart on the next mutation) and cleanup only removes empty active carts.
  every(state, 15 * 60_000, 'cart-maintenance', 'cart-maintenance', async () => {
    const ab = await abandonStaleCarts(env.CART_ABANDON_HOURS);
    const cl = await cleanupExpiredCarts();
    if (ab.abandoned || cl.deleted) jobLog(`[jobs:cart] abandoned=${ab.abandoned} purged=${cl.deleted}`);
  });
  every(state, 60_000, 'webhooks', 'webhooks', () => deliverWebhooks({ log: jobLog })); // push due webhook deliveries every minute
  // REL-4: push due email_outbox rows every minute — retry/dead-letter the
  // order-confirmation path. Mirrors the webhook claim pattern (FOR UPDATE
  // SKIP LOCKED, exponential backoff, dead-letter after MAX_ATTEMPTS).
  every(state, 60_000, 'emails', 'emails', () => deliverEmails({ log: jobLog }));
  // Mobile push (0039): same cadence + claim pattern as emails. Gated on its own
  // switch so a deployment can queue pushes before the APNs key exists — the
  // outbox fills either way and drains when this flips on. deliverPushes also
  // self-no-ops when APNS_* is unconfigured, so this is belt-and-braces.
  if (env.JOBS_PUSH_ENABLED === '1') {
    every(state, 60_000, 'push', 'push', () => deliverPushes({}));
  }
  // SUBSCRIBER-1: push confirmed + unsynced subscribers to Listmonk every 5
  // minutes. Slower than email/webhook because it's a best-effort downstream
  // sync, not a real-time deliverability path — a 5-min lag is fine, and the
  // smaller cadence costs less when a store has hundreds of thousands of
  // subscribers (Listmonk's /api/subscribers is rate-limited upstream).
  every(state, 5 * 60_000, 'listmonk-sync', 'listmonk-sync', () => listmonkSync({ log: jobLog }));
  // PAR-4: flip stale 'success' SheerID rows to 'expired' and recompute the
  // customers' active_verifications — drops verified_customer coupon
  // eligibility for lapsed verifications. Hourly: expiry granularity is days.
  every(state, HOUR, 'sheerid-expiry', 'sheerid-expiry', () => sheeridExpirySweep({ log: jobLog }));
  // REWARDS-1: birthday bonus (once per customer per year; no-op while the rule is off).
  every(state, HOUR, 'birthday-bonus', 'birthday-bonus', () => birthdayBonusSweep({ log: jobLog }));
  // PAR-5: the stock trigger queues restock_event rows on <=0→>0 transitions;
  // this drains them into one-shot customer notifications (claim inside the
  // txn — crash-safe, no double-notify).
  every(state, 60_000, 'restock-notify', 'restock-notify', async () => {
    const r = await sweepRestockEvents();
    if (r.events || r.notified) jobLog(`[jobs:restock] events=${r.events} notified=${r.notified}`);
  });
  // WP1.7 safety net: reset webhook_delivery rows stuck in 'processing' (a
  // crashed scheduler) back to 'pending' so the next pass re-claims them.
  // 10-min grace = a crashed worker is recovered within 15 min.
  const webhookReaperApply = env.JOBS_WEBHOOK_REAPER_APPLY === '1';
  const webhookReaperGraceMin = env.JOBS_WEBHOOK_REAPER_GRACE_MIN ?? 10;
  every(state, 5 * 60_000, 'webhook-reaper', 'webhook-reaper', () => reapStuckWebhooks({ apply: webhookReaperApply, graceMin: webhookReaperGraceMin, log: jobLog }));
  // processed_event never had a reaper — it gets one row per Stripe webhook id
  // plus one per payment idempotency claim and neither writer ever deletes it,
  // so the table grows forever. Retention defaults to 30 days, well past any
  // realistic idempotency/replay window. Runs hourly (this table is low-churn
  // compared to webhooks/emails, so a tighter cadence isn't needed).
  const processedEventReaperApply = env.JOBS_PROCESSED_EVENT_REAPER_APPLY === '1';
  const processedEventReaperRetentionDays = env.JOBS_PROCESSED_EVENT_REAPER_RETENTION_DAYS ?? 30;
  every(state, HOUR, 'processed-event-reaper', 'processed-event-reaper', () =>
    reapProcessedEvents({ apply: processedEventReaperApply, retentionDays: processedEventReaperRetentionDays, log: jobLog }));
  // SELLRIGHT-ISSUES P1: shared rate-limit backend retention cleanup. Every
  // window here is <=1hr, so rows older than a day are unambiguously stale —
  // always applies (no dry-run flag), same posture as cart-maintenance.ts.
  every(state, HOUR, 'rate-limit-reaper', 'rate-limit-reaper', async () => {
    const r = await reapRateLimitAttempts(24);
    if (r.deleted) jobLog(`[jobs:rate-limit] reaped=${r.deleted}`);
  });
  for (const job of extraJobs) {
    every(state, job.intervalMs, `${job.plugin}:${job.name}`, `plugin:${job.plugin}:${job.name}`, job.run);
  }

  return {
    enabled: true,
    jobs: state.names,
    async stop(timeoutMs = 5_000) {
      state.stopped = true;
      for (const t of state.timers) { clearInterval(t); clearTimeout(t); }
      state.timers.clear();
      if (state.inflight.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
      await Promise.race([Promise.allSettled([...state.inflight]).then(() => undefined), deadline]);
      clearTimeout(timer);
    },
  };
}
