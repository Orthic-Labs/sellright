import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { assertSafeOutboundUrl, safeOutboundFetch } from '../security/outbound-url.js';
import { invalidateStoreCache } from '../store-context.js';
import { HttpError, J, errBody, money, requireAdmin, requireStore, requireWrite, requireManage, requirePermission, guard } from './admin-helpers.js';
import { err as logErr } from '../lib/logger.js';

export const adminMarketing = new OpenAPIHono();

// ── promotions / discounts manager ───────────────────────────────────────────
const promoBody = z.object({
  code: z.string().min(1).nullable().optional(), // null/omitted = AUTOMATIC discount
  type: z.enum(['percentage', 'fixed', 'free_shipping']),
  value: money.default(0), // percentage: 0–100; fixed: cents
  conditions: z.array(z.unknown()).nullable().optional(),
  usageLimit: z.number().int().nullable().optional(),
  perCustomerUsageLimit: z.number().int().nullable().optional(),
  priority: z.number().int().optional(), // automatic-discount tie-break (higher wins)
  exclusionGroup: z.string().nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

adminMarketing.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/promotions', summary: 'List promotions',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) =>
      tx.select({ id: s.promotion.id, code: s.promotion.code, type: s.promotion.type, value: s.promotion.value, enabled: s.promotion.enabled, usedCount: s.promotion.usedCount, usageLimit: s.promotion.usageLimit, perCustomerUsageLimit: s.promotion.perCustomerUsageLimit, startsAt: s.promotion.startsAt, endsAt: s.promotion.endsAt })
        .from(s.promotion).orderBy(desc(s.promotion.enabled), s.promotion.code),
    );
    return c.json({ items: items.map((p) => ({ ...p, startsAt: p.startsAt?.toISOString() ?? null, endsAt: p.endsAt?.toISOString() ?? null })) }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/promotions', summary: 'Create a promotion',
    request: { body: { content: J(promoBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 409: { description: 'Code exists', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      if (b.code) {
        const [dupe] = await tx.select({ id: s.promotion.id }).from(s.promotion).where(eq(s.promotion.code, b.code)).limit(1);
        if (dupe) return { dupe: true as const };
      }
      const [p] = await tx.insert(s.promotion).values({
        storeId: st.storeId, code: b.code ?? null, type: b.type, value: b.value,
        conditions: b.conditions ?? null, usageLimit: b.usageLimit ?? null, perCustomerUsageLimit: b.perCustomerUsageLimit ?? null,
        priority: b.priority ?? 0, exclusionGroup: b.exclusionGroup ?? null,
        startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null, enabled: b.enabled,
      }).returning({ id: s.promotion.id });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'promotion', entityId: p!.id, action: 'create', data: { code: b.code } });
      return { id: p!.id };
    });
    if ('dupe' in res) throw new HttpError(409, `promotion code already exists: ${b.code}`);
    return c.json({ id: res.id }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/promotions/{id}', summary: 'Promotion detail + recent usage',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select().from(s.promotion).where(eq(s.promotion.id, id)).limit(1);
      if (!p) return null;
      const usage = await tx
        .select({ orderCode: s.order.code, email: s.customer.email, at: s.promotionUsage.createdAt })
        .from(s.promotionUsage)
        .innerJoin(s.order, eq(s.order.id, s.promotionUsage.orderId))
        .leftJoin(s.customer, eq(s.customer.id, s.promotionUsage.customerId))
        .where(eq(s.promotionUsage.promotionId, id)).orderBy(desc(s.promotionUsage.createdAt)).limit(50);
      return {
        id: p.id, code: p.code, type: p.type, value: p.value, conditions: p.conditions, enabled: p.enabled,
        usedCount: p.usedCount, usageLimit: p.usageLimit, perCustomerUsageLimit: p.perCustomerUsageLimit,
        startsAt: p.startsAt?.toISOString() ?? null, endsAt: p.endsAt?.toISOString() ?? null,
        usage: usage.map((u) => ({ ...u, at: u.at.toISOString() })),
      };
    });
    if (!out) throw new HttpError(404, 'promotion not found');
    return c.json(out, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/promotions/{id}', summary: 'Update a promotion',
    request: { params: z.object({ id: z.string() }), body: { content: J(promoBody.partial()) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ id: s.promotion.id }).from(s.promotion).where(eq(s.promotion.id, id)).limit(1);
      if (!p) return false;
      const patch: Record<string, unknown> = {};
      for (const k of ['code', 'type', 'value', 'conditions', 'usageLimit', 'perCustomerUsageLimit', 'priority', 'exclusionGroup', 'enabled'] as const) if (b[k] !== undefined) patch[k] = b[k];
      if (b.startsAt !== undefined) patch.startsAt = b.startsAt ? new Date(b.startsAt) : null;
      if (b.endsAt !== undefined) patch.endsAt = b.endsAt ? new Date(b.endsAt) : null;
      await tx.update(s.promotion).set(patch).where(eq(s.promotion.id, id));
      return true;
    });
    if (!ok) throw new HttpError(404, 'promotion not found');
    return c.json({ id }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/promotions/{id}', summary: 'Delete a promotion (only if unused)',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'In use', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const res = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ used: s.promotion.usedCount }).from(s.promotion).where(eq(s.promotion.id, id)).limit(1);
      if (!p) return 'notfound' as const;
      if (p.used > 0) return 'inuse' as const; // keep history; disable instead
      await tx.delete(s.promotion).where(eq(s.promotion.id, id));
      return 'ok' as const;
    });
    if (res === 'notfound') throw new HttpError(404, 'promotion not found');
    if (res === 'inuse') throw new HttpError(409, 'promotion has been used — disable it instead of deleting');
    return c.json({ id }, 200);
  }),
);

// ── Listmonk integration (managed IN the admin — no bouncing to Listmonk UI) ──
// Config lives in store.config.listmonk = { url, apiUser, apiToken }. The API
// proxies to the Listmonk REST API server-side (creds never reach the browser).
interface ListmonkCfg { url: string; apiUser: string; apiToken: string; }
async function getCfg(storeId: string): Promise<ListmonkCfg | null> {
  const [row] = await withStore(storeId, async (tx) =>
    tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1),
  );
  const lm = (row?.config as { listmonk?: ListmonkCfg } | null)?.listmonk;
  return lm?.url && lm?.apiToken ? lm : null;
}
async function lm(cfg: ListmonkCfg, path: string, init: RequestInit = {}): Promise<unknown> {
  const auth = Buffer.from(`${cfg.apiUser}:${cfg.apiToken}`).toString('base64');
  const baseUrl = cfg.url.replace(/\/$/, '');
  const res = await safeOutboundFetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(409, `listmonk ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

adminMarketing.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/marketing/config', summary: 'Listmonk connection status',
    responses: { 200: { description: 'OK', content: J(z.object({ configured: z.boolean(), url: z.string().nullable() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const cfg = await getCfg(st.storeId);
    return c.json({ configured: !!cfg, url: cfg?.url ?? null }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/marketing/config', summary: 'Set Listmonk connection',
    request: { body: { content: J(z.object({ url: z.string().url(), apiUser: z.string().min(1), apiToken: z.string().min(1) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean(), lists: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody }, 409: { description: 'Cannot connect', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const cfg = c.req.valid('json');
    const safeCfg = { ...cfg, url: await assertSafeOutboundUrl(cfg.url) };
    // Verify the connection before saving.
    const lists = (await lm(safeCfg, '/api/lists')) as { data?: { total?: number } };
    await withStore(st.storeId, async (tx) => {
      const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1).for('update');
      const config = { ...((row?.config as object) ?? {}), listmonk: safeCfg };
      await tx.update(s.store).set({ config }).where(eq(s.store.id, st.storeId));
    });
    invalidateStoreCache(st.slug); // PERF-2 — match admin-settings.ts pattern
    return c.json({ ok: true, lists: lists.data?.total ?? 0 }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/marketing/lists', summary: 'Listmonk lists',
    responses: { 200: { description: 'OK', content: J(z.any()) }, 409: { description: 'Not configured', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const cfg = await getCfg(st.storeId);
    if (!cfg) throw new HttpError(409, 'Listmonk not configured');
    const data = (await lm(cfg, '/api/lists?per_page=100')) as { data?: { results?: Array<{ id: number; name: string; subscriber_count: number; type: string }> } };
    return c.json({ lists: (data.data?.results ?? []).map((l) => ({ id: l.id, name: l.name, subscribers: l.subscriber_count, type: l.type })) }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/marketing/sync', summary: 'Push SellRight customers to a Listmonk list',
    request: { body: { content: J(z.object({ listId: z.number().int() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ synced: z.number().int(), failed: z.number().int() })) }, 409: { description: 'Not configured', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { listId } = c.req.valid('json');
    const cfg = await getCfg(st.storeId);
    if (!cfg) throw new HttpError(409, 'Listmonk not configured');
    const customers = await withStore(st.storeId, async (tx) =>
      tx.select({ email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName }).from(s.customer).where(and(eq(s.customer.emailVerified, true))).limit(5000),
    );
    let synced = 0; const failures: string[] = [];
    for (const cu of customers) {
      try {
        await lm(cfg, '/api/subscribers', { method: 'POST', body: JSON.stringify({ email: cu.email, name: [cu.firstName, cu.lastName].filter(Boolean).join(' ') || cu.email, lists: [listId], status: 'enabled', preconfirm_subscriptions: true }) });
        synced++;
      } catch (e) {
        // Per-record failure is usually "already subscribed" (re-sync) — keep going,
        // but don't pretend they all succeeded: count failures so a wholesale break
        // (bad token / Listmonk down → 0 synced, N failed) is visible, not silent.
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (failures.length) logErr.error('listmonk sync partial failure', undefined, { failed: failures.length, total: customers.length, firstError: failures[0] });
    await withStore(st.storeId, async (tx) => { await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'marketing', entityId: String(listId), action: 'listmonk_sync', data: { synced, failed: failures.length } }); });
    return c.json({ synced, failed: failures.length }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/marketing/campaigns', summary: 'Create a Listmonk campaign',
    request: { body: { content: J(z.object({ name: z.string().min(1), subject: z.string().min(1), listId: z.number().int(), body: z.string().default('') })) } },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 409: { description: 'Not configured', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const b = c.req.valid('json');
    const cfg = await getCfg(st.storeId);
    if (!cfg) throw new HttpError(409, 'Listmonk not configured');
    const out = (await lm(cfg, '/api/campaigns', { method: 'POST', body: JSON.stringify({ name: b.name, subject: b.subject, lists: [b.listId], type: 'regular', content_type: 'html', body: b.body || '<p></p>' }) })) as { data?: { id?: number } };
    return c.json({ id: out.data?.id ?? null, name: b.name }, 200);
  }),
);

// ── gift cards / store credit ─────────────────────────────────────────────────
const giftCode = () => 'GC-' + randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');

adminMarketing.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/gift-cards', summary: 'List gift cards',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => tx.select({ id: s.giftCard.id, code: s.giftCard.code, initialBalance: s.giftCard.initialBalance, balance: s.giftCard.balance, enabled: s.giftCard.enabled, expiresAt: s.giftCard.expiresAt }).from(s.giftCard).orderBy(desc(s.giftCard.createdAt)).limit(200));
    return c.json({ items: items.map((g) => ({ ...g, expiresAt: g.expiresAt?.toISOString() ?? null })) }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/gift-cards', summary: 'Issue a gift card',
    request: { body: { content: J(z.object({ balance: money, code: z.string().optional(), expiresAt: z.string().nullable().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), code: z.string() })) }, 409: { description: 'Code exists', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requirePermission(st, 'giftcards');
    const b = c.req.valid('json');
    const code = b.code || giftCode();
    const res = await withStore(st.storeId, async (tx) => {
      const [dupe] = await tx.select({ id: s.giftCard.id }).from(s.giftCard).where(eq(s.giftCard.code, code)).limit(1);
      if (dupe) return { dupe: true as const };
      const [g] = await tx.insert(s.giftCard).values({ storeId: st.storeId, code, initialBalance: b.balance, balance: b.balance, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null }).returning({ id: s.giftCard.id });
      await tx.insert(s.giftCardTransaction).values({ storeId: st.storeId, giftCardId: g!.id, amount: b.balance });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'gift_card', entityId: g!.id, action: 'issue', data: { balance: b.balance } });
      return { id: g!.id };
    });
    if ('dupe' in res) throw new HttpError(409, 'gift card code already exists');
    return c.json({ id: res.id, code }, 200);
  }),
);

adminMarketing.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/gift-cards/{id}', summary: 'Enable/disable or adjust a gift card',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ enabled: z.boolean().optional(), adjust: z.number().int().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), balance: money })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireManage(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [g] = await tx.select().from(s.giftCard).where(eq(s.giftCard.id, id)).limit(1);
      if (!g) return null;
      const balance = Math.max(0, g.balance + (b.adjust ?? 0));
      await tx.update(s.giftCard).set({ enabled: b.enabled ?? g.enabled, balance, updatedAt: new Date() }).where(eq(s.giftCard.id, id));
      if (b.adjust) await tx.insert(s.giftCardTransaction).values({ storeId: st.storeId, giftCardId: id, amount: b.adjust });
      return { balance };
    });
    if (!res) throw new HttpError(404, 'gift card not found');
    return c.json({ id, balance: res.balance }, 200);
  }),
);
