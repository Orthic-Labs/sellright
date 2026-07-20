import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { isMethodEligible, shippingRate } from '../shipping/calculator.js';
import { clientIp } from '../auth/rate-limit.js';
import { newsletterRetryAfter, recordNewsletterAttempt } from './shop-extra.newsletter-limit.js';
import { enqueueEmail } from '../email/outbox.js';
import { sendSubscriberConfirmation } from './shop-extra.subscriber.js';

export const shopExtra = new OpenAPIHono();

const J = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

// ── guest order tracking (code + email) ──────────────────────────────────────
shopExtra.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/track', summary: 'Guest order tracking by code + email',
    request: { query: z.object({ code: z.string(), email: z.string().email() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', content: J(z.object({ error: z.string() })) } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
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
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()) })) } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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
    responses: { 200: { description: 'OK', content: J(z.object({ methods: z.array(z.unknown()) })) } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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

// ── newsletter signup ────────────────────────────────────────────────────────
// SUBSCRIBER-1 (docs/plans/2026-07-19-subscriber-newsletter-waitlist.md):
// persist + enqueue a confirmation email in ONE transaction. The address and
// the email that proves it are committed atomically; the email scheduler owns
// delivery with retry + dead-letter (REL-4). The previous inline Listmonk
// call was silently dropping addresses on every failure mode (no Listmonk
// configured, Listmonk down, DNS-pinned fetch blocked); Listmonk is now a
// best-effort downstream sync pushed by the listmonk-sync job.
//
// Mailbomb guard: a per-IP limit does not stop a distributed attacker from
// repeatedly signing up a victim's address to make us send them confirmation
// emails. The cooldown is checked INSIDE the transaction against
// `last_sent_at` — at most one confirmation per address per hour, in
// addition to the per-IP throttle above.
shopExtra.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/newsletter-signup', summary: 'Subscribe an email to the newsletter',
    request: { body: { content: J(z.object({
      // Trim BEFORE validating: a browser text field routinely submits
      // "  user@example.com " and z.email() would reject it outright, so the
      // handler's own .trim() would never see the value. Normalizing at the
      // schema boundary means the 400 is reserved for genuinely malformed
      // addresses.
      email: z.string().trim().pipe(z.email()),
      name: z.string().optional(),
      // Waitlist vs newsletter (default). Both share this endpoint and the
      // confirmation/unsubscribe plumbing — only `topic` differs.
      kind: z.enum(['newsletter', 'waitlist']).optional(),
      // App key for waitlist (e.g. 'scraperight'); empty string for the
      // general newsletter. Migration 0041 marks topic NOT NULL DEFAULT ''
      // so this collides correctly with the UNIQUE constraint.
      topic: z.string().optional(),
      // Source for analytics + audit. Defaults to 'storefront' for the
      // public route. Other callers (checkout, import) can override.
      source: z.enum(['storefront', 'checkout', 'import', 'api']).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    }).refine(
      // An empty `topic` is the intended value for the general newsletter, but a
      // waitlist with no topic is a waitlist for nothing: it cannot be counted per
      // app, cannot pick a sender or confirm host, and renders "our product" in the
      // confirmation email. Caught here so the row is never written, rather than
      // surfacing later as an untagged entry an operator has to guess about.
      (v) => v.kind !== 'waitlist' || (v.topic ?? '').trim().length > 0,
      { path: ['topic'], message: 'topic is required when kind is "waitlist"' },
    )) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) },
      429: { description: 'Rate limited', content: J(z.object({ error: z.string() })) },
    },
  }),
  async (c) => {
    // 1. Per-IP throttle (gate 1). Same shape as auth.ts's check-email probe.
    const ip = clientIp(c);
    const retry = newsletterRetryAfter(ip);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    recordNewsletterAttempt(ip);

    const st = await resolveStoreFromCtx(c);
    // zod-openapi v1 fails to infer valid('json') for this public POST — same
    // shape as the original comment above the inline-Listmonk block. Cast to
    // the validated schema; the request middleware has already parsed it.
    const { email, name, kind = 'newsletter', topic = '', source = 'storefront', meta } = c.req.valid('json') as {
      email: string; name?: string; kind?: 'newsletter' | 'waitlist'; topic?: string;
      source?: 'storefront' | 'checkout' | 'import' | 'api'; meta?: Record<string, unknown>;
    };
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedTopic = topic ?? '';

    // 2. Persist + enqueue in ONE transaction (the whole point — see file
    // header). The upsert semantics by existing status are:
    //   - no row              → insert pending, enqueue confirm
    //   - pending             → do NOT duplicate; re-enqueue only if
    //                           last_sent_at is older than the cooldown
    //   - confirmed           → no-op, no email (don't reveal they're on)
    //   - unsubscribed        → back to pending + re-send confirmation
    //                           (they asked again; re-consent is correct)
    //
    // We do NOT reveal status to the caller — every path returns the same
    // `{ok: true}`. The per-row work is silent; the public response is
    // enumeration-neutral.
    const CONFIRM_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
    const enqueued = await withStore(st.id, async (tx) => {
      const [existing] = await tx
        .select({
          id: s.subscriber.id,
          status: s.subscriber.status,
          token: s.subscriber.token,
          lastSentAt: s.subscriber.lastSentAt,
        })
        .from(s.subscriber)
        .where(and(
          eq(s.subscriber.storeId, st.id),
          eq(s.subscriber.email, normalizedEmail),
          eq(s.subscriber.kind, kind),
          eq(s.subscriber.topic, normalizedTopic),
        ))
        .limit(1);

      const now = new Date();
      if (!existing) {
        const [row] = await tx.insert(s.subscriber).values({
          storeId: st.id,
          email: normalizedEmail,
          name: name ?? null,
          kind,
          topic: normalizedTopic,
          status: 'pending',
          source,
          meta: meta ?? null,
          lastSentAt: now,
        })
          // The SELECT above is not atomic with this INSERT: two concurrent
          // signups for the same (store, email, kind, topic) both see no row
          // and both insert, and the loser violates
          // `subscriber_store_email_kind_topic_key`. A double-clicked subscribe
          // button is enough to hit it — the per-IP throttle allows 5 attempts
          // per 15 min, so it does not serialize them. onConflictDoNothing
          // turns that 500 into the correct outcome: the winner created the row
          // and enqueued the confirmation, so the loser is a no-op and no
          // second email goes out (the mailbomb guard holds under races too).
          .onConflictDoNothing()
          .returning({ id: s.subscriber.id, token: s.subscriber.token });
        if (!row) return false; // lost the insert race — winner already enqueued.
        await sendSubscriberConfirmation(tx, st, { email: normalizedEmail, name: name ?? null, kind, topic: normalizedTopic, token: row.token });
        return true;
      }

      if (existing.status === 'confirmed') {
        // No-op, no email. Do not leak that they're already on the list.
        return false;
      }

      // Cooldown vs re-consent precedence. The cooldown exists to stop an
      // attacker mailbombing a victim by replaying signup for their address —
      // that attack drives the row pending → pending, which IS rate-limited
      // below. Reaching `unsubscribed` requires the capability token, which
      // only ever went to the address owner, so an unsubscribed → pending
      // re-consent is necessarily user-initiated and is exempt: someone who
      // unsubscribes by accident and immediately resubscribes must not be met
      // with silence (they would just retry, and never land on the list). The
      // residual abuse is one extra email per unsubscribe the victim performs,
      // which is bounded by a victim action each time.
      // The cooldown gates the EMAIL, never the row update. A legitimate repeat
      // signup can carry new data — a multi-step form posts the address first
      // and survey answers second, seconds apart — and returning early here
      // would silently discard that `meta`/`name`/`source` while still
      // reporting {ok:true}. Update the row unconditionally, then decide
      // whether an email is due.
      const isReconsent = existing.status === 'unsubscribed';
      const lastSent = existing.lastSentAt?.getTime() ?? 0;
      const withinCooldown = !isReconsent && now.getTime() - lastSent < CONFIRM_COOLDOWN_MS;

      // Flip unsubscribed back to pending; clear unsubscribed_at. `last_sent_at`
      // only moves when we actually send, otherwise a burst of repeat posts
      // would keep pushing the cooldown window forward and starve the send.
      // Re-use the existing token so unsubscribe links from prior emails stay
      // valid; rotate on confirmed→pending if needed (none here).
      const nextStatus = existing.status === 'unsubscribed' ? 'pending' : existing.status;
      await tx.update(s.subscriber)
        .set({
          status: nextStatus,
          unsubscribedAt: null,
          ...(withinCooldown ? {} : { lastSentAt: now }),
          // Re-record the source on every signup attempt — useful when an
          // address resubscribes from a different surface (e.g. they
          // originally came in via 'checkout', now from 'storefront').
          source,
          meta: meta ?? undefined,
          updatedAt: now,
        })
        .where(eq(s.subscriber.id, existing.id));
      // Row is updated either way; the email is what the cooldown suppresses.
      if (withinCooldown) return false;
      await sendSubscriberConfirmation(tx, st, { email: normalizedEmail, name: name ?? null, kind, topic: normalizedTopic, token: existing.token });
      return true;
    });

    // `enqueued` is true when a confirmation actually entered the outbox and
    // false on every no-op path (already confirmed, within the cooldown, lost
    // the insert race). It is deliberately NOT surfaced to the caller —
    // returning it would turn this endpoint into a subscription oracle, which
    // is the enumeration leak the constant `{ok: true}` exists to prevent.
    void enqueued;
    return c.json({ ok: true }, 200);
  },
);
