/**
 * Stand-alone pending-effects worker (de-fork plan 2.8). Drains
 * `order_pending_effect` rows left `pending` (deferred mode, "not ready"
 * retries, reclaimed stale claims) and exits cleanly on SIGTERM/SIGINT after
 * the in-flight pass. The API's own scheduler runs the same pass
 * (jobs/scheduler.ts, leader-locked); run this entry instead when the effects
 * should drain in a dedicated process:
 *
 *   node dist/scripts/effects-worker.js            # loop, EFFECTS_WORKER_INTERVAL_MS (default 15000)
 *   node dist/scripts/effects-worker.js --once     # one pass, then exit (cron / tests)
 *
 * Claims are SKIP LOCKED and token-fenced, so any number of workers (and the
 * scheduler) can run concurrently without double execution.
 */
import { pool } from '../db/client.js';
import { runEffectsPass } from '../payments/settlement/effects.js';
import '../payments/settlement/record.js'; // registers the built-in effect handlers

const once = process.argv.includes('--once');
const intervalMs = Math.max(1000, Number(process.env.EFFECTS_WORKER_INTERVAL_MS ?? 15_000));
let stopping = false;
let wake: (() => void) | null = null;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; wake?.(); });

async function main(): Promise<void> {
  do {
    const r = await runEffectsPass({ log: (m) => console.log(m) });
    if (r.done || r.retry || r.terminal || r.stale) console.log(`[effects] pass: ${JSON.stringify(r)}`);
    if (once || stopping) break;
    await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, intervalMs).unref?.(); });
  } while (!stopping);
}

main()
  .catch((error) => { console.error('[effects] failed', error); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
