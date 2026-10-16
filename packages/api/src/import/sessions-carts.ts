/** Import only frozen, still-valid source capabilities. No stock, money or order effects. */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';
import { parseJson, parseStrArray } from './store.js';
import type { ImportContext } from './context.js';

export const legacyTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export function validSourceSession(row: { invalidated: unknown; expires: unknown; type: unknown; channel: unknown }, channelId: number, now = Date.now()): boolean {
  return row.invalidated === false && Number(row.channel) === channelId &&
    ['AuthenticatedSession', 'AnonymousSession'].includes(String(row.type)) &&
    new Date(String(row.expires)).getTime() > now;
}

export async function importSessionsAndCarts(ctx: ImportContext): Promise<void> {
  const rows = await ctx.q(`SELECT ss.id, ss.token, ss.type, ss.invalidated, ss.expires,
    ss."activeChannelId" AS channel, ss."activeOrderId" AS oid, ss."userId" AS uid,
    c.id AS cid, c."emailAddress" AS email,
    EXISTS (SELECT 1 FROM administrator a WHERE a."userId"=ss."userId" AND a."deletedAt" IS NULL) AS admin
    FROM session ss LEFT JOIN customer c ON c."userId"=ss."userId" AND c."deletedAt" IS NULL
    WHERE ss.invalidated=false AND ss.expires > transaction_timestamp() AND ss."activeChannelId"=$1
    ORDER BY ss.id`, [ctx.channelId]);
  const now = Date.now();
  for (const row of rows) {
    if (!validSourceSession(row as Parameters<typeof validSourceSession>[0], ctx.channelId, now) || row.admin ||
      typeof row.token !== 'string' || !row.token ||
      (row.type === 'AuthenticatedSession' && (row.uid == null || row.cid == null)) ||
      (row.type === 'AnonymousSession' && row.uid != null)) continue;
    const authenticated = row.type === 'AuthenticatedSession';
    const customerId = authenticated ? ctx.id('customer', row.cid) : null;
    const tokenHash = legacyTokenHash(row.token);
    const sessionId = authenticated ? ctx.id('session', row.id) : null;
    const expiresAt = new Date(row.expires);
    if (sessionId && customerId) await ctx.tx.insert(s.session).values({
      id: sessionId, storeId: ctx.storeId, customerId, tokenHash, expiresAt, legacyExpiresAt: expiresAt,
    });
    let cartId: string | null = null;
    let couponCode: string | null = null;
    let countryCode: string | null = null;
    if (row.oid != null) {
      const [order] = await ctx.q(`SELECT o.id, o."couponCodes", o."shippingAddress"
        FROM "order" o JOIN order_channels_channel oc ON oc."orderId"=o.id
        WHERE o.id=$1 AND oc."channelId"=$2 AND o.active=true AND o."orderPlacedAt" IS NULL
          AND o."currencyCode"=$3 AND (o."customerId" IS NULL OR o."customerId"=$4)`,
      [row.oid, ctx.channelId, ctx.currency, authenticated ? row.cid : null]);
      if (order) {
        cartId = ctx.id('cart', order.id);
        const coupons = Array.isArray(order.couponCodes) ? order.couponCodes : typeof order.couponCodes === 'string'
          ? parseStrArray(order.couponCodes) ?? order.couponCodes.split(',').map(code => code.trim()).filter(Boolean) : [];
        if (coupons.length > 1) ctx.exclusions.push({ type: 'unmapped-source-field', table: 'order',
          detail: `active order ${order.id} has multiple coupon codes; target cart supports one revalidated coupon`,
          blocking: true, sourceValues: coupons.filter((code): code is string => typeof code === 'string') });
        couponCode = typeof coupons[0] === 'string' ? coupons[0] : null;
        const address = (typeof order.shippingAddress === 'object' && order.shippingAddress !== null ? order.shippingAddress : parseJson(order.shippingAddress) ?? {}) as Record<string, unknown>;
        countryCode = typeof address.countryCode === 'string' && /^[A-Z]{2}$/.test(address.countryCode) ? address.countryCode : null;
        // Several valid source sessions can reference the same active order.
        const inserted = await ctx.tx.insert(s.cart).values({ id: cartId, storeId: ctx.storeId,
          customerId, token: randomBytes(32).toString('hex'), expiresAt,
        }).onConflictDoNothing().returning({ id: s.cart.id });
        if (!inserted.length) await ctx.tx.update(s.cart).set({ expiresAt: sql`GREATEST(${s.cart.expiresAt}, ${expiresAt})` }).where(eq(s.cart.id, cartId));
        if (inserted.length) {
          const lines = await ctx.q('SELECT "productVariantId" AS vid, SUM(quantity)::int AS quantity FROM order_line WHERE "orderId"=$1 GROUP BY "productVariantId" ORDER BY "productVariantId"', [order.id]);
          for (const line of lines) {
            if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new Error('Invalid active-order quantity');
            const variants = await ctx.tx.select({ id: s.productVariant.id, sku: s.productVariant.sku }).from(s.productVariant)
              .where(and(eq(s.productVariant.storeId, ctx.storeId), sql`${s.productVariant.metafields}->>'vendureId' = ${String(line.vid)}`));
            const variant = variants.length === 1 ? variants[0] : undefined;
            await ctx.tx.insert(s.cartLine).values({ id: ctx.id('cart-line', `${order.id}:${line.vid}`),
              storeId: ctx.storeId, cartId, variantId: variant?.id ?? null,
              sku: variant?.sku ?? `vendure-unresolved:${line.vid}`, quantity: line.quantity });
          }
        }
      }
    }
    await ctx.tx.insert(s.legacySessionGrant).values({ id: ctx.id('session-grant', row.id), storeId: ctx.storeId,
      sourceKey: ctx.sourceKey, sourceSessionId: String(row.id), sourceUserId: row.uid == null ? null : String(row.uid),
      sourceCustomerId: row.cid == null ? null : String(row.cid), sourceEmail: authenticated ? normalizeEmail(row.email) : null,
      tokenHash, authenticated, customerId, sessionId, cartId, expiresAt, couponCode, countryCode });
  }
}
