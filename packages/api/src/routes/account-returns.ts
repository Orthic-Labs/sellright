/**
 * Customer-side return requests (RMA). The merchant side already existed
 * (admin opens / approves / rejects a `return_request`, approval refunds through
 * payments/refunds.ts) but a shopper had no way to ask: these two routes close
 * that loop for a signed-in customer.
 *
 *   GET  /v1/shop/account/orders/{code}/returns   what can still be returned + the requests made so far (with status)
 *   POST /v1/shop/account/orders/{code}/returns   ask to return shipped units of an owned, paid order
 *
 * Rules (enforced here, never trusted from the client):
 *  - the order belongs to the caller (same provenance proof as the order history);
 *  - only Paid / PartiallyRefunded orders; only units that actually shipped can come back;
 *  - a unit already refunded or already sitting in an open request is not offered again;
 *  - the shopper never picks `restock` (the merchant decides on approval) and never sees a refund amount
 *    before it is settled.
 * Status the shopper sees is the request's own status (requested / approved / refunded / rejected / received).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer, type SessionCustomer } from '../auth/session.js';
import { orderProvenanceFilter } from '../auth/order-access.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';

export const accountReturns = new OpenAPIHono();

const errSchema = apiErrorSchema();
const J = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
const OPEN_STATUSES = ['requested', 'approved', 'received'] as const;
const RETURNABLE_ORDER_STATES = ['Paid', 'PartiallyRefunded'];

const ReturnView = z.object({
  id: z.string(),
  status: z.enum(['requested', 'approved', 'rejected', 'received', 'refunded']),
  reason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int() })),
});
const ReturnsOut = z.object({
  /** Units of this order that can still be put in a new request, per SKU. */
  returnable: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int() })),
  items: z.array(ReturnView),
});

async function me(tx: Tx, token: string | null): Promise<SessionCustomer | null> {
  return token ? resolveCustomer(tx, token) : null;
}

interface Loaded {
  order: typeof s.order.$inferSelect;
  lines: Array<typeof s.orderLine.$inferSelect>;
  requests: Array<{ id: string; status: typeof s.returnRequest.$inferSelect['status']; reason: string | null; createdAt: Date; updatedAt: Date }>;
  requestLines: Array<{ returnId: string; orderLineId: string; quantity: number }>;
}

async function loadOwnedOrder(tx: Tx, cust: SessionCustomer, code: string, lock: boolean): Promise<Loaded | null> {
  const q = tx.select().from(s.order).where(and(eq(s.order.code, code), eq(s.order.customerId, cust.id), orderProvenanceFilter(cust))).limit(1);
  const [order] = await (lock ? q.for('update') : q);
  if (!order) return null;
  const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id)).orderBy(asc(s.orderLine.variantSku), asc(s.orderLine.id));
  const requests = await tx.select({
    id: s.returnRequest.id, status: s.returnRequest.status, reason: s.returnRequest.reason,
    createdAt: s.returnRequest.createdAt, updatedAt: s.returnRequest.updatedAt,
  }).from(s.returnRequest).where(eq(s.returnRequest.orderId, order.id)).orderBy(asc(s.returnRequest.createdAt));
  const requestLines = requests.length
    ? await tx.select({ returnId: s.returnLine.returnId, orderLineId: s.returnLine.orderLineId, quantity: s.returnLine.quantity })
      .from(s.returnLine).where(inArray(s.returnLine.returnId, requests.map((r) => r.id)))
    : [];
  return { order, lines, requests, requestLines };
}

/** Per order line: shipped, not yet refunded, not already in an open request. */
function returnableByLine(l: Loaded): Map<string, number> {
  const open = new Set(l.requests.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status)).map((r) => r.id));
  const inOpen = new Map<string, number>();
  for (const rl of l.requestLines) if (open.has(rl.returnId)) inOpen.set(rl.orderLineId, (inOpen.get(rl.orderLineId) ?? 0) + rl.quantity);
  const out = new Map<string, number>();
  if (!RETURNABLE_ORDER_STATES.includes(l.order.state)) return out;
  for (const line of l.lines) {
    const n = line.fulfilledQty - line.refundedQty - (inOpen.get(line.id) ?? 0);
    if (n > 0) out.set(line.id, n);
  }
  return out;
}

function view(l: Loaded): z.infer<typeof ReturnsOut> {
  const byLine = new Map(l.lines.map((x) => [x.id, x]));
  const left = returnableByLine(l);
  // Returnable units merged per SKU (an order can carry the same SKU on two lines).
  const merged = new Map<string, { sku: string; name: string; quantity: number }>();
  for (const [lineId, n] of left) {
    const line = byLine.get(lineId)!;
    const cur = merged.get(line.variantSku);
    if (cur) cur.quantity += n; else merged.set(line.variantSku, { sku: line.variantSku, name: line.variantName, quantity: n });
  }
  return {
    returnable: [...merged.values()],
    items: l.requests.map((r) => ({
      id: r.id, status: r.status, reason: r.reason, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
      lines: l.requestLines.filter((rl) => rl.returnId === r.id).map((rl) => {
        const line = byLine.get(rl.orderLineId);
        return { sku: line?.variantSku ?? '', name: line?.variantName ?? '', quantity: rl.quantity };
      }),
    })),
  };
}

accountReturns.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/orders/{code}/returns', summary: 'Returnable units and return requests for an owned order',
    request: { params: z.object({ code: z.string().min(1).max(128) }) },
    responses: {
      200: { description: 'OK', content: J(ReturnsOut) },
      401: { description: 'Unauthenticated', content: J(errSchema) },
      404: { description: 'Not found', content: J(errSchema) },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return 'unauth' as const;
      const loaded = await loadOwnedOrder(tx, cust, code, false);
      return loaded ? view(loaded) : ('notfound' as const);
    });
    if (out === 'unauth') return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out === 'notfound') return errJson(c, 404, 'ORDER_NOT_FOUND', 'order not found');
    return c.json(out, 200);
  },
);

const CreateIn = z.object({
  lines: z.array(z.object({ sku: z.string().min(1).max(200), quantity: z.number().int().min(1).max(100000) })).min(1).max(100),
  reason: z.string().trim().min(3).max(2000),
});

accountReturns.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/account/orders/{code}/returns', summary: 'Request a return for shipped units of an owned order',
    request: { params: z.object({ code: z.string().min(1).max(128) }), body: { content: { 'application/json': { schema: CreateIn } } } },
    responses: {
      201: { description: 'Requested', content: J(z.object({ id: z.string(), status: z.literal('requested') })) },
      401: { description: 'Unauthenticated', content: J(errSchema) },
      404: { description: 'Not found', content: J(errSchema) },
      409: { description: 'Nothing returnable / quantity too high', content: J(errSchema) },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return { kind: 'unauth' as const };
      const loaded = await loadOwnedOrder(tx, cust, code, true); // row lock: two concurrent requests cannot both claim the same units
      if (!loaded) return { kind: 'notfound' as const };
      const left = returnableByLine(loaded);
      if (left.size === 0) return { kind: 'conflict' as const, message: 'no items on this order can be returned yet' };
      // Allocate each requested SKU across its lines (oldest line first).
      const picks: Array<{ orderLineId: string; quantity: number }> = [];
      const seen = new Set<string>();
      for (const want of body.lines) {
        if (seen.has(want.sku)) return { kind: 'conflict' as const, message: `${want.sku} is listed twice` };
        seen.add(want.sku);
        let remaining = want.quantity;
        for (const line of loaded.lines.filter((x) => x.variantSku === want.sku)) {
          const n = Math.min(remaining, left.get(line.id) ?? 0);
          if (n > 0) { picks.push({ orderLineId: line.id, quantity: n }); remaining -= n; }
        }
        if (remaining > 0) return { kind: 'conflict' as const, message: `only ${want.quantity - remaining} of ${want.sku} can be returned` };
      }
      const [rr] = await tx.insert(s.returnRequest).values({ storeId: st.id, orderId: loaded.order.id, reason: body.reason, status: 'requested' }).returning({ id: s.returnRequest.id });
      // restock=false: nothing is shelved again because a customer asked; the merchant opts in when approving.
      await tx.insert(s.returnLine).values(picks.map((p) => ({ storeId: st.id, returnId: rr!.id, orderLineId: p.orderLineId, quantity: p.quantity, restock: false })));
      await tx.insert(s.auditLog).values({ storeId: st.id, actor: cust.email, entity: 'return', entityId: rr!.id, action: 'create', data: { orderCode: code, lines: picks.length, source: 'customer' } });
      return { kind: 'ok' as const, id: rr!.id };
    });
    if (out.kind === 'unauth') return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out.kind === 'notfound') return errJson(c, 404, 'ORDER_NOT_FOUND', 'order not found');
    if (out.kind === 'conflict') return errJson(c, 409, 'NOT_RETURNABLE', out.message);
    return c.json({ id: out.id, status: 'requested' as const }, 201);
  },
);
