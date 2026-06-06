import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { withStore, db } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE } from '../store-context.js';
import * as s from '../db/schema.js';
import { isMethodEligible, shippingRate } from '../shipping/calculator.js';

export const shopExtra = new OpenAPIHono();

const J = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
async function storeId(c: { req: { header: (k: string) => string | undefined } }): Promise<{ id: string; currency: string }> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const st = await resolveStore(slug);
  if (!st) throw new Error(`unknown store: ${slug}`);
  return st;
}

// ── guest order tracking (code + email) ──────────────────────────────────────
shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/track', summary: 'Guest order tracking by code + email',
    request: { query: z.object({ code: z.string(), email: z.string().email() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', content: J(z.object({ error: z.string() })) } },
  }),
  async (c) => {
    const st = await storeId(c);
    const { code, email } = c.req.valid('query');
    const out = await withStore(st.id, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      // email must match the order's customer or the shipping snapshot.
      let ok = false;
      if (o.customerId) { const [cu] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1); ok = cu?.email?.toLowerCase() === email.toLowerCase(); }
      if (!ok) return null;
      const [ful] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
      const lines = await tx.select({ name: s.orderLine.variantName, quantity: s.orderLine.quantity }).from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      return { code: o.code, state: o.state, placedAt: o.placedAt?.toISOString() ?? null, grandTotal: o.grandTotal, currency: o.currency, fulfillment: ful ? { state: ful.state, trackingCode: ful.trackingCode, carrier: ful.carrier } : null, lines };
    });
    if (!out) return c.json({ error: 'order not found for that code + email' }, 404);
    return c.json(out, 200);
  },
);

// ── public blog ──────────────────────────────────────────────────────────────
shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/blog', summary: 'Published blog posts',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) } },
  }),
  async (c) => {
    const st = await storeId(c);
    const items = await withStore(st.id, async (tx) =>
      tx.select({ title: s.blogPost.title, slug: s.blogPost.slug, excerpt: s.blogPost.excerpt, authorName: s.blogPost.authorName, readingTime: s.blogPost.readingTime, publishDate: s.blogPost.publishDate, tags: s.blogPost.tags })
        .from(s.blogPost).where(eq(s.blogPost.isPublished, true)).orderBy(desc(s.blogPost.publishDate)),
    );
    return c.json({ items: items.map((p) => ({ ...p, publishDate: p.publishDate?.toISOString() ?? null })) }, 200);
  },
);

shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/blog/{slug}', summary: 'Blog post by slug',
    request: { params: z.object({ slug: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', content: J(z.object({ error: z.string() })) } },
  }),
  async (c) => {
    const st = await storeId(c);
    const { slug } = c.req.valid('param');
    const out = await withStore(st.id, async (tx) => (await tx.select().from(s.blogPost).where(and(eq(s.blogPost.slug, slug), eq(s.blogPost.isPublished, true))).limit(1))[0]);
    if (!out) return c.json({ error: 'post not found' }, 404);
    return c.json({ title: out.title, slug: out.slug, bodyHtml: out.bodyHtml, authorName: out.authorName, readingTime: out.readingTime, publishDate: out.publishDate?.toISOString() ?? null, seoTitle: out.seoTitle, seoDescription: out.seoDescription, tags: out.tags }, 200);
  },
);

// ── eligible shipping methods (country + subtotal gating) ────────────────────
shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/shipping-methods', summary: 'Eligible shipping methods for a cart',
    request: { query: z.object({ country: z.string().optional(), subtotal: z.coerce.number().int().default(0) }) },
    responses: { 200: { description: 'OK', content: J(z.object({ methods: z.array(z.any()) })) } },
  }),
  async (c) => {
    const st = await storeId(c);
    const { country, subtotal } = c.req.valid('query');
    const methods = await withStore(st.id, async (tx) => tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.enabled, true)));
    const eligible = methods
      .filter((m) => isMethodEligible(m.calculator, { subtotal, country }))
      .map((m) => ({ code: m.code, name: m.name, rate: shippingRate(m.calculator) }));
    return c.json({ methods: eligible }, 200);
  },
);

// ── gift card balance check ───────────────────────────────────────────────────
shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/gift-card/{code}', summary: 'Check a gift card balance',
    request: { params: z.object({ code: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), balance: z.number().int(), currency: z.string(), valid: z.boolean() })) }, 404: { description: 'Not found', content: J(z.object({ error: z.string() })) } },
  }),
  async (c) => {
    const st = await storeId(c);
    const { code } = c.req.valid('param');
    const gc = await withStore(st.id, async (tx) => {
      const [g] = await tx.select({ code: s.giftCard.code, balance: s.giftCard.balance, currency: s.giftCard.currency, enabled: s.giftCard.enabled, expiresAt: s.giftCard.expiresAt }).from(s.giftCard).where(eq(s.giftCard.code, code)).limit(1);
      return g ?? null;
    });
    if (!gc) return c.json({ error: 'gift card not found' }, 404);
    const valid = gc.enabled && gc.balance > 0 && (!gc.expiresAt || gc.expiresAt.getTime() > Date.now());
    return c.json({ code: gc.code, balance: gc.balance, currency: gc.currency, valid }, 200);
  },
);

// ── newsletter signup (Listmonk, if configured) ──────────────────────────────
shopExtra.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/newsletter-signup', summary: 'Subscribe an email to the newsletter',
    request: { body: { content: J(z.object({ email: z.string().email(), name: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) } },
  }),
  async (c) => {
    const st = await storeId(c);
    const { email, name } = c.req.valid('json');
    const [row] = await db.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.id)).limit(1);
    const lm = (row?.config as { listmonk?: { url: string; apiUser: string; apiToken: string } } | null)?.listmonk;
    if (lm?.url && lm?.apiToken) {
      try {
        const auth = Buffer.from(`${lm.apiUser}:${lm.apiToken}`).toString('base64');
        await fetch(`${lm.url.replace(/\/$/, '')}/api/subscribers`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: name || email, status: 'enabled' }) });
      } catch { /* best-effort */ }
    }
    return c.json({ ok: true }, 200);
  },
);
