/**
 * PAR-05: back-in-stock automation — port of the legacy waitlist plugin's
 * restock path (damned waitlist.service.ts + waitlist-restock.listener.ts).
 *
 * Model: `restock_request` (migration 0049) is a one-shot "notify me" signup
 * per (store, variant, email). Unlike the topic-based newsletter/waitlist
 * subscriber system it is single-purpose: the signup IS the consent for
 * exactly one transactional email, every notification carries a per-row
 * cancel link, and the pending→notified claim makes once-per-restock
 * enforceable under concurrency.
 *
 * Two subscription surfaces feed the same notifier:
 *   - POST /v1/shop/restock-request (below) — dedicated one-shot signups in
 *     `restock_request`.
 *   - the existing topic-based waitlist: a `subscriber` row with
 *     kind='waitlist' AND topic='restock:<variantId>' (subscribable through
 *     POST /v1/shop/newsletter-signup) is claimed here too — but only when
 *     status='confirmed' (double opt-in = consent). Claiming flips the row
 *     to 'unsubscribed': the one-shot waitlist is consumed by its
 *     notification, exactly like the legacy plugin's pending→notified.
 *
 * Trigger coverage: stock writes are scattered across files owned by other
 * lanes (admin-products PATCH /variants/:id/stock, admin-catalog
 * location-stock upsert + variant create, release-stale-allocations job,
 * returns restock, catalog import). A Postgres trigger on `stock` records a
 * `restock_event` row whenever availability crosses 0 → >0, so NO writer
 * needs a code change for the notification to land. sweepRestockEvents()
 * drains the queue — wire it into jobs/scheduler.ts (see report); for
 * immediate, synchronous notification a call site may also invoke
 * notifyRestock(storeId, variantId) directly.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { clientIp } from '../auth/rate-limit.js';
import { restockRetryAfter, recordRestockAttempt } from './contact.limit.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { turnstileSecret } from './contact.js';
import { enqueueEmail } from '../email/outbox.js';
import { appValue } from '../email/dispatch.js';
import { restockNotify } from '../email/templates-contact.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

export const restockRoutes = new OpenAPIHono();

const J = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
   <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 24px;color:#222">
     <h2 style="margin:0 0 12px">${title}</h2>
     <p style="line-height:1.5">${body}</p>
   </body></html>`;

function cancelUrl(base: string, token: string): string {
  return `${base.replace(/\/$/, '')}/v1/shop/restock-request/cancel/${token}`;
}

function productUrl(base: string, slug: string): string {
  return `${base.replace(/\/$/, '')}/products/${slug}`;
}

// ── POST /v1/shop/restock-request ──────────────────────────────────────────
// Public "notify me when back in stock" signup. Idempotent per
// (store, variant, email) while pending; a new pending row is allowed again
// after the previous one was notified/canceled (re-arm for the next cycle).
// Always {ok:true} for existing/duplicate signups — no list enumeration.
const RestockIn = z.object({
  variantId: z.string().uuid(),
  email: z.string().trim().pipe(z.email()).pipe(z.string().max(320)),
  turnstileToken: z.string().optional(),
  honeypot: z.string().optional(),
  website: z.string().optional(),
});

restockRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/restock-request', summary: 'Request a one-shot back-in-stock notification',
    request: { body: { content: J(RestockIn) } },
    responses: {
      200: { description: 'Recorded (or already recorded)', content: J(z.object({ ok: z.boolean() })) },
      400: { description: 'Invalid or failed security check', content: J(z.object({ error: z.string() })) },
      404: { description: 'Variant not found', content: J(z.object({ error: z.string() })) },
      429: { description: 'Rate limited', content: J(z.object({ error: z.string() })) },
    },
  }),
  async (c) => {
    const body = c.req.valid('json') as z.infer<typeof RestockIn>;
    if (body.honeypot || body.website) return c.json({ ok: true }, 200); // bot — fake success

    const ip = clientIp(c);
    const retry = restockRetryAfter(ip);
    if (retry > 0) return c.json({ error: `too many requests — try again in ${retry}s` }, 429);
    recordRestockAttempt(ip);

    const st = await resolveStoreFromCtx(c);

    const ok = await verifyTurnstileToken({ secret: turnstileSecret(st.config), token: body.turnstileToken, remoteIp: ip });
    if (!ok) return c.json({ error: 'security verification failed — please try again' }, 400);

    const email = body.email.trim().toLowerCase();

    const result = await withStore(st.id, async (tx) => {
      const v = await tx.execute(
        sql`SELECT pv.id, pv.name AS variant_name, p.name AS product_name, p.slug AS product_slug,
                   coalesce(stk.on_hand, 0) - coalesce(stk.allocated, 0) AS available
            FROM product_variant pv
            JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
            LEFT JOIN stock stk ON stk.variant_id = pv.id
            WHERE pv.id = ${body.variantId} AND pv.deleted_at IS NULL AND pv.enabled = true
            LIMIT 1`,
      );
      const variant = v.rows[0] as { id: string; variant_name: string; product_name: string; product_slug: string; available: number } | undefined;
      if (!variant) return 'not-found' as const;
      // Already purchasable → the request would just linger until the NEXT
      // cycle. No-op success (the shopper can buy it right now).
      if (variant.available > 0) return 'in-stock' as const;
      await tx.execute(
        sql`INSERT INTO restock_request (store_id, variant_id, email, product_name, variant_name, product_slug, source)
            VALUES (${st.id}, ${variant.id}, ${email}, ${variant.product_name}, ${variant.variant_name}, ${variant.product_slug}, 'storefront')
            ON CONFLICT DO NOTHING`,
      );
      return 'recorded' as const;
    });

    if (result === 'not-found') return c.json({ error: 'variant not found' }, 404);
    return c.json({ ok: true }, 200);
  },
);

// ── GET+POST /v1/shop/restock-request/cancel/{token} ───────────────────────
// Consent revocation. GET is a landing page with a POST form — a mail
// scanner prefetching the link must not cancel the request (same rule the
// subscriber unsubscribe route follows); POST performs the cancel.
restockRoutes.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/restock-request/cancel/{token}', summary: 'Cancel-request landing page',
    request: { params: z.object({ token: z.string().uuid() }) },
    responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: z.string() } } } },
  }),
  async (c) => {
    const body = `<p>You asked to be notified when an item comes back in stock. Click below to cancel that request.</p>
      <form method="post" action="">
        <button type="submit" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer">Cancel notification</button>
      </form>`;
    return c.html(html('Cancel stock notification', body), 200);
  },
);

restockRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/restock-request/cancel/{token}', summary: 'Cancel a restock request',
    request: { params: z.object({ token: z.string().uuid() }) },
    responses: { 200: { description: 'OK', content: { 'text/html': { schema: z.string() } } } },
  }),
  async (c) => {
    const { token } = c.req.valid('param');
    // The token is a 122-bit capability. The emailed cancel link always points
    // at the store's own storefront host, so the store is resolved from the
    // request context — an unscoped lookup would see zero rows under the
    // runtime RLS role (SR-01) and must never exist.
    let st: { id: string } | null = null;
    try {
      st = await resolveStoreFromCtx(c);
    } catch {
      st = null; // unresolvable host → same generic page, no enumeration.
    }
    if (st) {
      await withStore(st.id, async (tx) => {
        await tx.execute(
          sql`UPDATE restock_request SET status = 'canceled', updated_at = now()
              WHERE token = ${token} AND store_id = ${st!.id} AND status = 'pending'`,
        );
      });
    }
    // Same page hit or miss — no enumeration.
    return c.html(html('Canceled', 'Your notification request has been canceled. You can close this tab.'), 200);
  },
);

// ── notifier core ──────────────────────────────────────────────────────────
/**
 * Claim every pending restock_request for a variant and enqueue one email
 * each — inside the caller's transaction. The UPDATE … WHERE status='pending'
 * claim is the dedupe primitive: two concurrent calls cannot both claim a
 * row, and a notified row is never claimed again. Consent check: only
 * 'pending' rows (explicitly requested, not canceled) are emailed.
 * Returns the number of notifications enqueued.
 */
async function processRestockTx(
  tx: Tx,
  storeId: string,
  variantId: string,
  store: { name: string; currency: string },
): Promise<number> {
  // Guard: only notify when the variant is actually available right now.
  // Makes this safe to invoke on any stock write — an OOS→OOS or
  // in-stock→in-stock move finds avail <= 0 / claims nothing. Also resolves
  // the variant's app_key so a licensed-app restock emails from that app's
  // storefront/sender — the same per-app resolution dispatch.ts::emailCtx
  // applies, not the global STOREFRONT_URL for every brand.
  const avail = await tx.execute(
    sql`SELECT coalesce(stk.on_hand, 0) - coalesce(stk.allocated, 0) AS n,
               pv.name AS variant_name, pv.app_key, p.name AS product_name, p.slug AS product_slug
        FROM product_variant pv
        JOIN product p ON p.id = pv.product_id
        LEFT JOIN stock stk ON stk.variant_id = pv.id
        WHERE pv.id = ${variantId} AND pv.deleted_at IS NULL LIMIT 1`,
  );
  const info = avail.rows[0] as { n: number; variant_name: string; app_key: string | null; product_name: string; product_slug: string } | undefined;
  if (!info || info.n <= 0) return 0;

  const storefront = appValue(env.STOREFRONT_URL_BY_APP, info.app_key) ?? env.STOREFRONT_URL;
  const fromEmail = appValue(env.EMAIL_FROM_BY_APP, info.app_key) ?? env.SMTP_FROM;

  const claimed = await tx.execute(
    sql`UPDATE restock_request
        SET status = 'notified', notified_at = now(), updated_at = now()
        WHERE variant_id = ${variantId} AND store_id = ${storeId} AND status = 'pending'
        RETURNING email, product_name, variant_name, product_slug, token`,
  );
  const ctx = { name: store.name, currency: store.currency, storefrontUrl: storefront, fromEmail };
  for (const row of claimed.rows as Array<{ email: string; product_name: string; variant_name: string; product_slug: string; token: string }>) {
    const rendered = restockNotify(ctx, {
      productName: row.product_name,
      variantName: row.variant_name,
      productUrl: productUrl(storefront, row.product_slug),
      cancelUrl: cancelUrl(storefront, row.token),
    });
    await enqueueEmail(tx, storeId, {
      kind: 'restock_notify',
      recipient: row.email,
      payload: { to: row.email, from: ctx.fromEmail, ...rendered },
    });
  }

  // Also drain the topic-based waitlist lane (subscriber rows whose topic is
  // this variant). Consent gate: only 'confirmed' rows are emailed — pending
  // signups that never double-opted-in are left alone. The claim flips them
  // to 'unsubscribed', which is the consumed/terminal state for a one-shot
  // notification and makes re-sending structurally impossible; a later
  // re-signup goes through the normal re-consent path.
  const topic = `restock:${variantId}`;
  const claimedSubs = await tx.execute(
    sql`UPDATE subscriber
        SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
        WHERE store_id = ${storeId} AND kind = 'waitlist' AND topic = ${topic} AND status = 'confirmed'
        RETURNING id, email, signup_group`,
  );
  const subRows = claimedSubs.rows as Array<{ id: string; email: string; signup_group: string | null }>;
  // Imported product-level signups expand to one row per variant topic, all
  // sharing a signup_group. The shopper asked once, so the group is consumed
  // once: flip every confirmed sibling-topic row in the same claim (no mail —
  // the claimed row on this topic is the group's representative) so a later
  // restock of another variant cannot re-email them (DD parity). Rows with a
  // NULL group (native single-variant signups) are each their own consumption
  // unit — unchanged behavior.
  const groups = [...new Set(subRows.map((r) => r.signup_group).filter((g): g is string => g != null))];
  if (groups.length) {
    await tx.execute(
      sql`UPDATE subscriber
          SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
          WHERE store_id = ${storeId} AND kind = 'waitlist' AND status = 'confirmed'
            AND signup_group IN ${groups}`,
    );
  }
  // The variant/product names + slug were resolved above (same query as the
  // availability guard) — the subscriber lane has no denormalized copy.
  // Exactly one mail per signup group; the claimed row is the representative.
  // (Two claimed rows can never share a group in practice — same group = same
  // source signup = same email, and (store,email,kind,topic) is unique — the
  // dedupe is a guard, not the mechanism.)
  let subsNotified = 0;
  const mailedGroups = new Set<string>();
  for (const row of subRows) {
    const dedupeKey = row.signup_group ?? `row:${row.id}`;
    if (mailedGroups.has(dedupeKey)) continue;
    mailedGroups.add(dedupeKey);
    const rendered = restockNotify(ctx, {
      productName: info.product_name,
      variantName: info.variant_name,
      productUrl: productUrl(storefront, info.product_slug),
      // Subscriber rows' own unsubscribe capability is already consumed by
      // this claim — link back to the product instead.
      cancelUrl: productUrl(storefront, info.product_slug),
    });
    await enqueueEmail(tx, storeId, {
      kind: 'restock_notify',
      recipient: row.email,
      payload: { to: row.email, from: ctx.fromEmail, ...rendered },
    });
    subsNotified++;
  }

  return claimed.rows.length + subsNotified;
}

/**
 * Direct-call notifier for stock write paths (admin stock PATCH, import,
 * allocation release…). Safe to call unconditionally after any stock write —
 * it no-ops when the variant isn't currently available. Runs its own
 * store-scoped transaction so callers don't have to share theirs.
 */
export async function notifyRestock(storeId: string, variantId: string): Promise<number> {
  // `store` is RLS-exempt — resolve it before opening the scoped txn.
  const st = (await pool.query<{ name: string; currency: string }>(
    'SELECT name, currency FROM store WHERE id = $1 LIMIT 1', [storeId],
  )).rows[0];
  if (!st) return 0;
  const n = await withStore(storeId, (tx) => processRestockTx(tx, storeId, variantId, st));
  if (n > 0) log.info('restock notifications enqueued', { storeId, variantId, count: n });
  return n;
}

/**
 * Drain the restock_event queue written by the `stock` trigger. Per store:
 * claim pending events and process each variant inside the same transaction,
 * so a crash mid-sweep rolls back both the claim and the email enqueues —
 * nothing is half-applied. Returns {events, notified} for the scheduler log.
 */
export async function sweepRestockEvents(opts: { limit?: number } = {}): Promise<{ events: number; notified: number }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
  const stores = await pool.query<{ id: string; name: string; currency: string }>('SELECT id, name, currency FROM store');
  let events = 0;
  let notified = 0;
  for (const st of stores.rows) {
    const res = await withStore(st.id, async (tx) => {
      const claimed = await tx.execute(
        sql`UPDATE restock_event SET processed_at = now()
            WHERE id IN (
              SELECT id FROM restock_event
              WHERE processed_at IS NULL
              ORDER BY created_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING variant_id`,
      );
      const variantIds = [...new Set((claimed.rows as Array<{ variant_id: string }>).map((r) => r.variant_id))];
      let n = 0;
      for (const variantId of variantIds) {
        n += await processRestockTx(tx, st.id, variantId, st);
      }
      return { events: claimed.rows.length, notified: n };
    });
    events += res.events;
    notified += res.notified;
  }
  if (events > 0) log.info('restock sweep', { events, notified });
  return { events, notified };
}
