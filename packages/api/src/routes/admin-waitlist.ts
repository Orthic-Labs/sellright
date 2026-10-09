/**
 * G10: admin waitlist demand report (signups per product / variant, pending vs
 * notified) + CSV download. Read-only and aggregate — no shopper emails.
 * Logic lives in waitlist/report.ts.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { withStore } from '../db/client.js';
import { dayRangeError } from '../lib/day-range.js';
import { WAITLIST_SORTS, waitlistCsv, waitlistReport, type WaitlistGroup, type WaitlistSort } from '../waitlist/report.js';
import { HttpError, J, errBody, requireAdmin, requireStore, guard } from './admin-helpers.js';

export const adminWaitlist = new OpenAPIHono();

const Query = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(['variant', 'product']).default('variant'),
  sort: z.enum(WAITLIST_SORTS as unknown as [WaitlistSort, ...WaitlistSort[]]).default('pending'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const Row = z.object({
  key: z.string(), productName: z.string(), productSlug: z.string().nullable(), variantName: z.string().nullable(), sku: z.string().nullable(),
  available: z.number().int().nullable(), variants: z.number().int(),
  pending: z.number().int(), notified: z.number().int(), canceled: z.number().int(), unconfirmed: z.number().int(), legacyClosed: z.number().int(), total: z.number().int(),
  lastSignupAt: z.string().nullable(), oldestPendingAt: z.string().nullable(),
});
const ReportOut = z.object({
  groupBy: z.enum(['variant', 'product']),
  range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  summary: z.object({ pending: z.number().int(), notified: z.number().int(), canceled: z.number().int(), unconfirmed: z.number().int(), legacyClosed: z.number().int(), total: z.number().int(), products: z.number().int(), variants: z.number().int() }),
  rows: z.array(Row),
  truncated: z.boolean(),
});

async function load(c: Parameters<typeof requireStore>[1], q: z.infer<typeof Query>) {
  const { admin } = await requireAdmin(c);
  const st = requireStore(admin, c);
  const range = { from: q.from, to: q.to };
  const bad = dayRangeError(range);
  if (bad) throw new HttpError(400, bad);
  return withStore(st.storeId, (tx) => waitlistReport(tx, st.storeId, { range, groupBy: q.groupBy as WaitlistGroup, sort: q.sort, dir: q.dir }));
}

adminWaitlist.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/waitlist/report', summary: 'Waitlist demand: signups per variant or product, pending vs notified',
    request: { query: Query },
    responses: { 200: { description: 'OK', content: J(ReportOut) }, 400: { description: 'Bad range', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => c.json(await load(c, c.req.valid('query')), 200)),
);

adminWaitlist.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/waitlist/report.csv', summary: 'Waitlist demand report as CSV',
    request: { query: Query },
    responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, 400: { description: 'Bad range', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const q = c.req.valid('query');
    const report = await load(c, q);
    return c.body(waitlistCsv(report), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="waitlist-demand-${q.groupBy}.csv"` });
  }),
);
