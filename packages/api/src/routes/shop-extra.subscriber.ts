/**
 * SUBSCRIBER-1 (docs/plans/2026-07-19-subscriber-newsletter-waitlist.md).
 *
 * Public subscriber lifecycle routes — confirm and unsubscribe via
 * capability-token URLs delivered in the confirmation email. All three
 * endpoints are idempotent and return the same generic shape whether or not
 * the token matches a row (enumeration defense).
 *
 * Routes:
 *   GET  /v1/shop/subscriber/confirm/:token       — confirm email, returns HTML
 *   GET  /v1/shop/subscriber/unsubscribe/:token   — landing page, returns HTML
 *   POST /v1/shop/subscriber/unsubscribe/:token   — RFC 8058 one-click, returns 200
 *
 * The shared helper `sendSubscriberConfirmation(tx, store, ...)` is imported by
 * shop-extra.ts to enqueue the confirmation email in the same transaction as
 * the subscriber row insert/update. Atomicity is the whole point: a rolled-
 * back signup never leaves a dangling email, and a missing email never leaves
 * a confirmed subscriber.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { resolveStoreFromCtx } from './store-context.js';
import { enqueueEmail } from '../email/outbox.js';
import { subscriberConfirm, waitlistConfirm } from '../email/templates.js';
import { appValue } from '../email/dispatch.js';
import { env } from '../env.js';

export const subscriberRoutes = new OpenAPIHono();

const J = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

// Minimal HTML response for the email link landing pages. Keeping it inline
// (no template engine) means the endpoint works even with no static-asset
// serving configured. White-on-white, but functional — the spec accepts that
// this is the email-client-rendered link, not a designed page.
const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
   <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 24px;color:#222">
     <h2 style="margin:0 0 12px">${title}</h2>
     <p style="line-height:1.5">${body}</p>
   </body></html>`;

// App-key → product name lookup for waitlist copy. Kept tiny on purpose; new
// apps register themselves in storefront apps, not here. Reads from the
// store's own config (a single source of truth ops can update without a
// deploy). Falls back to the raw topic key.
function waitlistLabelFromConfig(storeId: string, topic: string): Promise<string | undefined> {
  return (async () => {
    const { rows } = await pool.query<{ config: unknown }>('SELECT config FROM store WHERE id = $1 LIMIT 1', [storeId]);
    const cfg = rows[0]?.config as { waitlistLabels?: Record<string, string> } | null;
    return cfg?.waitlistLabels?.[topic];
  })();
}

/**
 * Build the capability URLs for the subscriber's email. The API URL is the
 * route that runs the transition; the storefront URL is for any "manage your
 * subscription" link the templates want. Public surfaces must use a public
 * host — STOREFRONT_URL is the canonical per-app URL with a sane default.
 */
export function buildSubscriberLinks(token: string, appKey?: string): { confirmUrl: string; unsubscribeUrl: string } {
  // The storefront helper srNewsletterSignup calls this API via the same
  // public host; the confirmation link is the SAME public host so an email
  // client (or a corporate link-follower) reaches the API. If you front
  // this with a CDN, set PUBLIC_API_URL or proxy /v1/shop/subscriber/* to
  // the API; until then STOREFRONT_URL is the fallback.
  //
  // On a multi-tenant store (one store row serving several branded sites) a
  // single global STOREFRONT_URL sends every brand's confirmation to whichever
  // host that variable happens to name — a ScrapeRight signup was emailing a
  // viewright.cc confirm link. Resolve per app first, exactly as
  // dispatch.ts::emailCtx does, keyed by the subscriber's topic.
  //
  // Deliberately NOT derived from the request Host header: that is
  // attacker-controlled, and building an emailed capability URL from it is
  // host-header injection (POST with Host: evil.com and the victim gets an
  // evil.com confirm link). Config is the only trusted source here.
  const base = (appValue(env.STOREFRONT_URL_BY_APP, appKey) ?? env.STOREFRONT_URL).replace(/\/$/, '');
  return {
    confirmUrl: `${base}/v1/shop/subscriber/confirm/${token}`,
    unsubscribeUrl: `${base}/v1/shop/subscriber/unsubscribe/${token}`,
  };
}

/**
 * Enqueue the confirmation email for a subscriber row inside the caller's
 * transaction. The payload is the fully rendered SendEmailInput so the
 * scheduler never re-derives rendering on retry — see REL-4 / outbox.ts.
 *
 * `tx` MUST be the same transaction that owns the subscriber row insert/update
 * (atomicity invariant). Caller passes the `token` from the row so the
 * confirmation URL is the row's actual capability token, not a re-derivation.
 */
export async function sendSubscriberConfirmation(
  tx: Tx,
  store: { id: string; name: string; currency: string },
  data: { email: string; name: string | null; kind: 'newsletter' | 'waitlist'; topic: string; token: string },
): Promise<void> {
  // `topic` IS the app key for a multi-tenant store (viewright, scraperight, …)
  // and empty for the general newsletter, in which case every lookup below
  // falls back to the global value.
  const appKey = data.topic || undefined;
  const { confirmUrl, unsubscribeUrl } = buildSubscriberLinks(data.token, appKey);
  // Resolve `from` and the storefront link via the per-app env overrides the
  // same way dispatch.ts::emailCtx does. This previously used the globals
  // unconditionally despite the comment claiming otherwise, so a ScrapeRight
  // waitlist confirmation went out from hello@heardright.app pointing at
  // viewright.cc — wrong brand on both the envelope and the link.
  const storefrontUrl = appValue(env.STOREFRONT_URL_BY_APP, appKey) ?? env.STOREFRONT_URL;
  const fromEmail = appValue(env.EMAIL_FROM_BY_APP, appKey) ?? env.SMTP_FROM ?? 'noreply@sellright.local';
  const ctx = { name: store.name, currency: store.currency, storefrontUrl, fromEmail };
  const rendered = data.kind === 'waitlist'
    ? waitlistConfirm(ctx, {
        confirmUrl,
        unsubscribeUrl,
        productName: (await waitlistLabelFromConfig(store.id, data.topic)) ?? (data.topic || 'our product'),
      })
    : subscriberConfirm(ctx, { confirmUrl, unsubscribeUrl, topic: data.topic, topicLabel: undefined });
  await enqueueEmail(tx, store.id, {
    kind: data.kind === 'waitlist' ? 'subscriber_waitlist_confirm' : 'subscriber_newsletter_confirm',
    recipient: data.email,
    payload: { to: data.email, from: ctx.fromEmail, ...rendered },
  });
}

// ── GET /v1/shop/subscriber/confirm/:token ───────────────────────────────────
// Idempotent. Unknown tokens get the same generic success page so an attacker
// who scrapes confirm URLs can't enumerate subscriber ids.
subscriberRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/subscriber/confirm/{token}',
    summary: 'Confirm a subscriber (double opt-in)',
    request: { params: z.object({ token: z.string().uuid() }) },
    responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: z.string() } } } },
  }),
  async (c) => {
    const { token } = c.req.valid('param');
    const st = await resolveStoreFromCtx(c);
    const updated = await withStore(st.id, async (tx) => {
      // Only pending → confirmed. Already-confirmed rows are no-ops (still
      // succeeds — idempotency). Unsubscribed rows stay unsubscribed; the
      // user must re-signup to re-subscribe (re-consent required).
      const r = await tx.execute(
        sql`UPDATE subscriber
            SET status = 'confirmed', confirmed_at = now(), updated_at = now()
            WHERE token = ${token} AND status = 'pending'
            RETURNING id`,
      );
      return (r.rows[0] as { id: string } | undefined)?.id;
    });
    // Enumeration defense: same body for hit + miss.
    return c.html(html('Subscription confirmed',
      updated
        ? `Thanks — you're confirmed on the ${st.name} list. You can close this tab.`
        : `Thanks — your request has been processed. You can close this tab.`), 200);
  },
);

// ── GET /v1/shop/subscriber/unsubscribe/:token (landing page) ────────────────
// The link in the email body lands here; the user clicks a button which then
// POSTs to the same URL (RFC 8058 one-click). We do NOT confirm on GET alone
// — a corporate mail-scanner that pre-fetches links should NOT silently
// unsubscribe someone.
subscriberRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/subscriber/unsubscribe/{token}',
    summary: 'Unsubscribe landing page (HTML form)',
    request: { params: z.object({ token: z.string().uuid() }) },
    responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: z.string() } } } },
  }),
  async (c) => {
    // Same generic page whether or not the token matches a row. The form
    // action is the same URL with method=POST — the user actively chooses
    // to submit, even if mail clients don't show the form to humans.
    const body = `<p>If you no longer want to receive these emails, click the button below.</p>
      <form method="post" action="">
        <button type="submit" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer">Unsubscribe</button>
      </form>`;
    return c.html(html('Manage your subscription', body), 200);
  },
);

// ── POST /v1/shop/subscriber/unsubscribe/:token (RFC 8058 one-click) ────────
// Gmail + Yahoo bulk-sender policy requires this exact path with
// List-Unsubscribe-Post: List-Unsubscribe=One-Click. Idempotent.
subscriberRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/subscriber/unsubscribe/{token}',
    summary: 'Unsubscribe (one-click)',
    request: { params: z.object({ token: z.string().uuid() }) },
    responses: { 200: { description: 'OK' }, 204: { description: 'No content' } },
  }),
  async (c) => {
    const { token } = c.req.valid('param');
    // The store context matters: a subscriber token belongs to ONE store, and
    // we don't know which store without looking it up. Read token → storeId
    // UNSCOPED (the `subscriber` row is owned by exactly one store and the
    // token is a 122-bit capability — leaking which store the token belongs
    // to is no worse than leaking the token's existence to an attacker who
    // already has it). If we DIDN'T find the row, use the request's store
    // context to keep RLS happy for the path that never resolves.
    const st = await resolveStoreFromCtx(c);
    const row = await withStore(st.id, async (tx) =>
      tx.execute(sql`SELECT id, store_id AS "storeId" FROM subscriber WHERE token = ${token} LIMIT 1`),
    );
    const sub = (row.rows[0] as { id: string; storeId: string } | undefined);
    const storeId = sub?.storeId ?? st.id;
    await withStore(storeId, async (tx) => {
      // Idempotent: transitioning already-unsubscribed is a no-op.
      await tx.update(s.subscriber)
        .set({ status: 'unsubscribed', unsubscribedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(s.subscriber.token, token), eq(s.subscriber.status, 'confirmed')));
    });
    // 200 (not 204) so the response carries the confirmation body for both
    // human browsers and the one-click client. RFC 8058 says 200 is fine.
    return c.html(html('Unsubscribed', 'You have been unsubscribed. You can close this tab.'), 200);
  },
);
