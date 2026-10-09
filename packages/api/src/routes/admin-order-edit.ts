/**
 * Order editing (spec G13 / G5): Shopify-style editing of paid orders.
 *
 *   GET  /v1/admin/orders/{code}/edit/context   what can be edited + shipping methods + history
 *   GET  /v1/admin/orders/{code}/edit/variants  variant picker (add / swap)
 *   POST /v1/admin/orders/{code}/edit/preview   stateless: totals, line diff, stock, balance
 *   POST /v1/admin/orders/{code}/edit/commit    guarded by expectedGrandTotal, idempotent, settles the balance
 *   PUT  /v1/admin/orders/{code}/address        direct address save (no customer address-book requirement)
 *
 * Deliberately NOT PATCH /v1/admin/orders/{code}/lines: that route rebuilds
 * every line and would wipe fulfilled/refunded quantities on a paid order.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HttpError, J, errBody, money, requireAdmin, requirePermission, requireStore, requireWrite, guard } from './admin-helpers.js';
import {
  AddressInput, EditOp, OrderEditError, Settlement, normalizeAddress,
} from '../orders/order-edit.js';
import { commitOrderEdit, loadEditContext, retryOrderEditRefund, previewOrderEdit, saveOrderAddress, searchEditVariants } from '../orders/order-edit-service.js';

export const adminOrderEdit = new OpenAPIHono();

/** Map the domain error to the structured admin envelope. */
async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof OrderEditError) throw new HttpError(e.status, e.message, e.code, undefined, e.extra);
    throw e;
  }
}

const Ops = z.array(EditOp).max(100);
const responses = {
  200: { description: 'OK', content: J(z.any()) },
  404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody },
  400: { description: 'Invalid', ...errBody }, 401: { description: 'Unauthorized', ...errBody },
};

adminOrderEdit.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}/edit/context', summary: 'Order-edit context (locks, shipping methods, history)',
    request: { params: z.object({ code: z.string() }) }, responses,
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { code } = c.req.valid('param');
    return c.json(await translate(() => loadEditContext(st.storeId, code)), 200);
  }),
);

adminOrderEdit.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}/edit/variants', summary: 'Search variants to add to / swap on an order',
    request: { params: z.object({ code: z.string() }), query: z.object({ q: z.string().trim().min(1).max(100) }) }, responses,
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q } = c.req.valid('query');
    return c.json({ items: await searchEditVariants(st.storeId, q) }, 200);
  }),
);

adminOrderEdit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/edit/preview', summary: 'Preview an order edit (stateless; nothing is written)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ ops: Ops })) } }, responses,
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { code } = c.req.valid('param');
    const { ops } = c.req.valid('json');
    return c.json(await translate(() => previewOrderEdit(st.storeId, code, ops)), 200);
  }),
);

adminOrderEdit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/edit/commit', summary: 'Commit an order edit and settle its balance',
    request: {
      params: z.object({ code: z.string() }),
      body: { content: J(z.object({
        ops: Ops.min(1),
        expectedGrandTotal: money.min(0),
        expectedBalance: money.optional(),
        idempotencyKey: z.string().min(1).max(200),
        settlement: Settlement.optional(),
        notifyCustomer: z.boolean().default(true),
        reason: z.string().trim().max(1000).optional(),
      })) },
    }, responses,
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    // Money leaving the business needs the same permission as the Refund panel.
    if (body.settlement?.type === 'refund_now') requirePermission(st, 'refunds');
    const result = await translate(() => commitOrderEdit({
      storeId: st.storeId, storeSlug: st.slug, code, actor: admin.email, ops: body.ops,
      expectedGrandTotal: body.expectedGrandTotal, expectedBalance: body.expectedBalance, idempotencyKey: body.idempotencyKey,
      settlement: body.settlement, notifyCustomer: body.notifyCustomer, reason: body.reason,
    }));
    return c.json(result, 200);
  }),
);

adminOrderEdit.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/orders/{code}/address', summary: 'Edit an order address directly (any non-cancelled order)',
    request: {
      params: z.object({ code: z.string() }),
      body: { content: J(z.object({
        kind: z.enum(['shipping', 'billing']),
        address: AddressInput,
        // Optional, default off: also copy the address into the customer's address book.
        saveToAddressBook: z.boolean().default(false),
        reason: z.string().trim().max(1000).optional(),
      })) },
    }, responses,
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    return c.json(await translate(() => saveOrderAddress({
      storeId: st.storeId, code, actor: admin.email, kind: body.kind, address: normalizeAddress(body.address),
      saveToAddressBook: body.saveToAddressBook, reason: body.reason,
    })), 200);
  }),
);

adminOrderEdit.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/edit/{editId}/refund', summary: 'Retry (or turn into credit) the failed refund of an order edit',
    request: {
      params: z.object({ code: z.string(), editId: z.string().uuid() }),
      body: { content: J(z.object({ action: z.enum(['retry', 'credit']), paymentId: z.string().uuid().optional() })) },
    }, responses,
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'refunds');
    const { code, editId } = c.req.valid('param');
    const body = c.req.valid('json');
    return c.json(await translate(() => retryOrderEditRefund({ storeId: st.storeId, code, editId, actor: admin.email, action: body.action, paymentId: body.paymentId })), 200);
  }),
);
