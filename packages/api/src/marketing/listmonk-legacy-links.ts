/**
 * Legacy Listmonk newsletter links (`/newsletter/confirm/{uuid}`,
 * `/newsletter/unsubscribe/{uuid}`) — mail already sent by the previous
 * the previous platform/Listmonk install (V: damned/admin/src/plugins/listmonk/*, O:
 * damned/store/src/routes/newsletter/{confirm,unsubscribe}/[subscriber]).
 *
 * The storefront renders the pages; this API route performs the Listmonk call
 * so the per-store connection (store.config.listmonk — the same config the
 * admin Marketing screen and jobs/listmonk-sync.ts use) is the single source of
 * truth and no Listmonk credential has to exist in the storefront env.
 *
 *   POST /v1/shop/newsletter/legacy/{confirm|unsubscribe}/{uuid}
 *
 * The uuid is Listmonk's own per-subscriber capability; the store is resolved
 * from the request exactly like every other shop route, and only that store's
 * list is ever touched. The Listmonk URL is admin-supplied, so every fetch goes
 * through safeOutboundFetch (SSRF guard), same as the sync job.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { resolveStoreFromCtx } from '../routes/store-context.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { getCfg, type ListmonkCfg } from '../jobs/listmonk-sync.js';
import { safeOutboundFetch } from '../security/outbound-url.js';
import { withRequestDeadline } from '../security/request-deadline.js';

export type LegacyLinkAction = 'confirm' | 'unsubscribe';
export type LegacyLinkResult = 'confirmed' | 'already_confirmed' | 'unsubscribed' | 'already_unsubscribed';
export type LegacyLinkOutcome =
  | { ok: true; result: LegacyLinkResult; email: string }
  | { ok: false; reason: 'not_found' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 10_000;

type RawSubscriber = {
  id: number; uuid: string; email: string; status?: string;
  lists: Array<{ id: number; subscription_status: 'confirmed' | 'unconfirmed' | 'unsubscribed' }>;
};

/**
 * Look the subscriber up by uuid and apply the action to this store's list only.
 * Idempotent. Throws on any Listmonk transport/HTTP failure (caller maps to 502).
 * An unsubscribed member is never re-added by a confirm link: that would revive
 * revoked consent (same rule as shop-extra.subscriber.ts — re-consent needs a
 * fresh signup).
 */
export async function applyLegacyLink(
  cfg: ListmonkCfg, action: LegacyLinkAction, uuid: string,
  fetchImpl: typeof safeOutboundFetch = safeOutboundFetch,
): Promise<LegacyLinkOutcome> {
  const listId = cfg.listId;
  if (!UUID_RE.test(uuid) || !Number.isSafeInteger(listId) || !listId || listId <= 0) return { ok: false, reason: 'not_found' };
  const auth = Buffer.from(`${cfg.apiUser}:${cfg.apiToken}`).toString('base64');
  const baseUrl = cfg.url.replace(/\/$/, '');
  const request = (path: string, init: RequestInit = {}) => withRequestDeadline(TIMEOUT_MS, signal => fetchImpl(`${baseUrl}${path}`, {
    ...init, signal,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
  }));

  const query = encodeURIComponent(`subscribers.uuid = '${uuid}'`);
  const found = await request(`/api/subscribers?query=${query}&per_page=1`);
  if (!found.ok) throw new Error(`subscriber lookup HTTP ${found.status}`);
  const body = await found.json() as { data?: { results?: RawSubscriber[] } };
  const sub = body.data?.results?.[0];
  if (!sub || !Number.isSafeInteger(sub.id) || sub.uuid?.toLowerCase() !== uuid.toLowerCase() || !Array.isArray(sub.lists)) return { ok: false, reason: 'not_found' };
  if (sub.status === 'blocklisted' || sub.status === 'disabled') return { ok: false, reason: 'not_found' };

  const status = sub.lists.find((l) => l.id === listId)?.subscription_status ?? 'not_subscribed';
  const write = async (payload: Record<string, unknown>) => {
    const res = await request('/api/subscribers/lists', { method: 'PUT', body: JSON.stringify({ ids: [sub.id], target_list_ids: [listId], ...payload }) });
    if (!res.ok) throw new Error(`list update HTTP ${res.status}`);
  };

  if (action === 'confirm') {
    if (status === 'confirmed') return { ok: true, result: 'already_confirmed', email: sub.email };
    if (status === 'unsubscribed') return { ok: true, result: 'already_unsubscribed', email: sub.email };
    await write({ action: 'add', status: 'confirmed' });
    return { ok: true, result: 'confirmed', email: sub.email };
  }
  if (status === 'unsubscribed' || status === 'not_subscribed') return { ok: true, result: 'already_unsubscribed', email: sub.email };
  await write({ action: 'unsubscribe' });
  return { ok: true, result: 'unsubscribed', email: sub.email };
}

export const listmonkLegacyLinkRoutes = new OpenAPIHono();

listmonkLegacyLinkRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/newsletter/legacy/{action}/{uuid}',
    summary: 'Confirm or unsubscribe via a legacy Listmonk email link',
    request: { params: z.object({ action: z.enum(['confirm', 'unsubscribe']), uuid: z.string().uuid() }) },
    responses: {
      200: { description: 'Applied (idempotent)', content: { 'application/json': { schema: z.object({
        result: z.enum(['confirmed', 'already_confirmed', 'unsubscribed', 'already_unsubscribed']), email: z.string(),
      }) } } },
      404: { description: 'Listmonk not configured for this store, or no such subscriber', content: { 'application/json': { schema: apiErrorSchema() } } },
      502: { description: 'Listmonk unreachable', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const { action, uuid } = c.req.valid('param');
    const st = await resolveStoreFromCtx(c);
    const cfg = await getCfg(st.id);
    if (!cfg) return errJson(c, 404, 'NOT_FOUND', 'link not valid');
    let outcome: LegacyLinkOutcome;
    try {
      outcome = await applyLegacyLink(cfg, action, uuid);
    } catch (e) {
      console.error(`[newsletter/${action}] listmonk error: ${e instanceof Error ? e.message : String(e)}`);
      return errJson(c, 502, 'UPSTREAM_UNAVAILABLE', 'newsletter system unavailable');
    }
    if (!outcome.ok) return errJson(c, 404, 'NOT_FOUND', 'link not valid');
    return c.json({ result: outcome.result, email: outcome.email }, 200);
  },
);
