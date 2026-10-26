// #381 Order Export page (admin/src/pages/OrderExport.tsx): count of matching orders and the download. A port of the
// previous admin's order-tools export (orders/order-export-page.ts holds the statuses, columns and shapes).
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { HttpError, requireAdmin, requireStore } from './admin-helpers.js';
import {
  countExportOrders, exportCsv, exportWorkbook, fetchExportLines, parseExportShape, parseOrderExportFilters, shapeExport,
} from '../orders/order-export-page.js';

export const adminOrderExport = new OpenAPIHono();

adminOrderExport.get('/v1/admin/order-export/count', async (c) => {
  try {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    return c.json({ totalOrders: await countExportOrders(st.storeId, parseOrderExportFilters((k) => c.req.query(k))) }, 200);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

adminOrderExport.get('/v1/admin/order-export', async (c) => {
  try {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const filters = parseOrderExportFilters((k) => c.req.query(k));
    if (!filters.statuses.length) throw new HttpError(400, 'Select at least one status');
    const shape = parseExportShape((k) => c.req.query(k));
    const shaped = shapeExport(await fetchExportLines(st.storeId, filters), shape);
    const [store] = (await withStore(st.storeId, (tx) => tx.execute(sql`select name from store where id = ${st.storeId}`))).rows as Array<{ name: string }>;
    const filename = `orders_export_${new Date().toISOString().slice(0, 10)}.${shape.format}`;
    const headers = {
      'content-disposition': `attachment; filename="${filename}"`,
      'x-export-orders': String(shaped.orders), 'x-export-rows': String(shaped.rows.length),
      'access-control-expose-headers': 'content-disposition, x-export-orders, x-export-rows',
    };
    if (shape.format === 'csv') return c.body(exportCsv(shaped), 200, { ...headers, 'content-type': 'text/csv; charset=utf-8' });
    const buf = await exportWorkbook(shaped, store?.name ?? st.slug);
    return c.body(new Uint8Array(buf), 200, { ...headers, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});
