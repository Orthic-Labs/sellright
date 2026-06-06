import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { getProvider, isPaymentMethodEnabled } from '../payments/provider.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const found = await resolveStore(slug);
  if (!found) throw new Error(`unknown store: ${slug}`);
  return found;
}

export const pay = new OpenAPIHono();

// POST /v1/shop/orders/{code}/pay — take payment for an order, idempotent.
pay.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/orders/{code}/pay',
    summary: 'Pay for an order (PendingPayment -> Paid)',
    request: {
      params: z.object({ code: z.string() }),
      headers: z.object({ 'idempotency-key': z.string().optional() }),
      body: { content: { 'application/json': { schema: z.object({ method: z.string().default('manual'), token: z.unknown().optional() }) } } },
    },
    responses: {
      200: { description: 'Paid', content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), payment: z.string() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Not payable', content: { 'application/json': { schema: z.object({ error: z.string(), state: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { code } = c.req.valid('param');
    const { method } = c.req.valid('json');
    const idemKey = c.req.header('idempotency-key');

    const provider = getProvider(method);
    if (!provider) return c.json({ error: `unknown payment method: ${method}` }, 404);
    if (!isPaymentMethodEnabled(st.config, method)) return c.json({ error: `payment method disabled: ${method}`, state: 'Disabled' }, 409);

    type R =
      | { kind: 'notfound' }
      | { kind: 'badstate'; state: string }
      | { kind: 'noop'; state: string }
      | { kind: 'ok'; state: string; payment: string };

    const out: R = await withStore(st.id, async (tx): Promise<R> => {
      const [order] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!order) return { kind: 'notfound' };
      if (order.state !== 'PendingPayment') return { kind: 'badstate', state: order.state };

      // Idempotency: claim the key before any side effect; duplicate = no-op.
      if (idemKey) {
        const claimed = await tx
          .insert(s.processedEvent)
          .values({ id: idemKey, storeId: st.id, type: 'payment' })
          .onConflictDoNothing()
          .returning({ id: s.processedEvent.id });
        if (claimed.length === 0) return { kind: 'noop', state: order.state };
      }

      const result = await provider.createPayment({ orderCode: code, amount: order.grandTotal, currency: order.currency });
      await tx.insert(s.payment).values({
        storeId: st.id, orderId: order.id, amount: order.grandTotal, method: provider.method,
        providerRef: result.providerRef, state: result.state === 'Settled' ? 'Settled' : result.state === 'Authorized' ? 'Authorized' : 'Declined',
        metadata: result.metadata ?? null, errorMessage: result.errorMessage ?? null,
      });

      if (result.state === 'Settled' && canTransition(order.state as OrderState, 'Paid')) {
        await tx.update(s.order).set({ state: 'Paid', placedAt: new Date() }).where(eq(s.order.id, order.id));
        return { kind: 'ok', state: 'Paid', payment: 'Settled' };
      }
      return { kind: 'ok', state: order.state, payment: result.state };
    });

    if (out.kind === 'notfound') return c.json({ error: 'order not found' }, 404);
    if (out.kind === 'badstate') return c.json({ error: 'order is not payable', state: out.state }, 409);
    return c.json({ code, state: out.state, payment: out.kind === 'noop' ? 'already-processed' : out.payment }, 200);
  },
);
