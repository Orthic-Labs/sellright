/**
 * The one sanctioned way to flip maintenance mode (ADR-0001 I-4 / QS-6). Every toggle path goes through here — today
 * the `sellright maintenance on|off` CLI (scripts/maintenance-cli.ts, also driven by deploy/sellright.sh); any future
 * admin route, API or settings save must call this too (guarded by maintenance-toggle.test.ts, which fails if
 * setMaintenance() is called anywhere else). Writes the flag file first; once the write has landed, purges every
 * host of the store (host purge, multi-host/zone fan-out in cloudflare-purge.ts) with the shared retry + timeout +
 * `cache_purge_failed` alert (runPurge). A flag write failure throws (nothing changed, nothing to purge); the purge
 * itself never throws.
 */
import { env } from './env.js';
import { purgeHostForMaintenance, type PurgeResult } from './cache/purge-hook.js';
import { setMaintenance } from './maintenance.js';
import { err as logErr } from './lib/logger.js';

export async function toggleMaintenance(on: boolean, opts: { reason?: string; storeSlug?: string } = {}): Promise<PurgeResult> {
  setMaintenance(on, opts.reason);
  const storeSlug = opts.storeSlug ?? env.STORE_SLUG;
  if (!storeSlug) {
    logErr.error('maintenance toggled but no store slug to purge', new Error('STORE_SLUG unset'), { alert: 'cache_purge_failed', event: 'maintenance', phase: 'resolve', on });
    return 'failed';
  }
  try {
    return await purgeHostForMaintenance(storeSlug);
  } catch (e) {
    logErr.error('maintenance edge purge crashed', e, { alert: 'cache_purge_failed', event: 'maintenance', storeSlug });
    return 'failed';
  }
}
