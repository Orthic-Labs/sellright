/**
 * Cross-lane seam for the launch-audit fixes (SR-02).
 * Implemented by the roles/tenant-resolution lane; consumed by the payments lane.
 * Safe under the RLS nonowner runtime role: backed by a narrowly-privileged,
 * provider-account-bound lookup (SECURITY DEFINER or dedicated role), never a
 * broad BYPASSRLS read.
 */
import { Pool } from 'pg';
import { env } from '../env.js';

export type GatewayProviderName = 'stripe' | 'nmi' | 'sezzle';

export interface GatewayEventRefs {
  paymentRef?: string | null;
  subscriptionRef?: string | null;
  accountRef?: string | null;
  /**
   * 'test'|'live' when the event context knows the gateway mode (Stripe: the
   * webhook secret that verified the signature; NMI/Sezzle: the resolved
   * account profile). Strict resolution (migration 0060) EXCLUDES candidate
   * rows whose mode differs — or is unrecorded — when this is set; supply it
   * whenever it is knowable so a same-ref row from the other mode can't
   * resolve. Null/absent = unbound (resolution is by unique ref alone, still
   * failing closed on multi-store matches).
   */
  mode?: 'test' | 'live' | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS: ReadonlySet<string> = new Set(['stripe', 'nmi', 'sezzle']);
const REF_MAX = 200;

// The seam exists for webhook code that runs as the RLS nonowner role, so it
// prefers DATABASE_URL_NONOWNER (production split + the RLS test suite) and
// falls back to DATABASE_URL for single-role dev. A tiny lazy pool keeps
// resolution off the request pool's connection budget; the underlying
// SECURITY DEFINER function (migration 0053, strict since 0060) does the
// cross-tenant read and returns only a store_id.
const tenantPool = new Pool({
  connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL,
  application_name: `${env.PGAPPNAME}-tenant-resolution`,
  max: 2,
  idleTimeoutMillis: env.PGPOOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PGPOOL_CONNECTION_TIMEOUT_MS,
  allowExitOnIdle: true,
});

tenantPool.on('error', (err) => {
  console.error('[pg tenant-resolution pool error]', err);
});

function normalizeRef(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= REF_MAX ? trimmed : null;
}

/**
 * Resolve the owning storeId for a provider event without app.current_store.
 * Returns null when no ref resolves — callers decide whether to ack (one-time
 * events) or 5xx so the provider retries (subscription events).
 *
 * STRICT (0060): the function unions the DISTINCT store_ids of every
 * applicable lookup and resolves only a singleton — duplicate refs across
 * stores, or a ref hit excluded by the supplied account/mode bindings, return
 * null rather than guessing a tenant.
 */
export async function resolveStoreForGatewayEvent(
  provider: GatewayProviderName,
  refs: GatewayEventRefs,
): Promise<{ storeId: string } | null> {
  if (!PROVIDERS.has(provider)) return null;
  const paymentRef = normalizeRef(refs.paymentRef);
  const subscriptionRef = normalizeRef(refs.subscriptionRef);
  const accountRef = normalizeRef(refs.accountRef);
  const mode = refs.mode === 'test' || refs.mode === 'live' ? refs.mode : null;
  if (!paymentRef && !subscriptionRef && !accountRef) return null;
  const { rows } = await tenantPool.query<{ store_id: string | null }>(
    'SELECT public.resolve_store_for_gateway_event($1, $2, $3, $4, $5) AS store_id',
    [provider, paymentRef, subscriptionRef, accountRef, mode],
  );
  const storeId = rows[0]?.store_id;
  return storeId && UUID.test(storeId) ? { storeId } : null;
}
