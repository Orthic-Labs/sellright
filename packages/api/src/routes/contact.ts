/**
 * PAR-01: public contact form — port of the legacy Vendure contact-form
 * plugin (damned/rotten) onto the Hono + outbox stack.
 *
 * Preserved semantics from the source plugin:
 *   - honeypot field silently accepted (bot gets a fake success, no row)
 *   - Turnstile required when a secret is configured; skipped entirely when
 *     none is (feature disabled, see security/turnstile.ts)
 *   - per-IP rate limit (5/hour — contact.limit.ts)
 *   - validation bounds: name ≤200, subject required, message ≤5000
 *   - SIGNED confirmation link emailed to the SUBMITTER — not an account OTP.
 *     The message is NOT delivered on submit; only the first valid click on
 *     the link delivers it (confirm-before-deliver) to the per-store team
 *     inbox plus a customer acknowledgment.
 *   - duplicate-click suppression + 24h link expiry.
 *
 * Differences forced by the port: the legacy plugin carried the whole
 * submission in the signed URL and deduped clicks in Redis. Here the
 * submission is a durable `contact_submission` row (migration 0048) written
 * in the same transaction as the confirmation email (outbox atomicity —
 * REL-4), the link signs (id, ts), and the pending→delivered claim is the
 * dedupe primitive. All sends go through the email outbox — durable with
 * retry + dead-letter — never inline SMTP.
 *
 * Team routing: config.notifications.contactEmail (per-store, set via
 * PATCH /v1/admin/settings/notifications) → CONTACT_EMAIL env → SMTP_FROM.
 * Turnstile secret: config.turnstileSecret / config.turnstile.secretKey →
 * TURNSTILE_SECRET_KEY env.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStore, resolveStoreForRequest } from '../store-context.js';
import { resolveStoreFromCtx } from './store-context.js';
import { clientIp } from '../auth/rate-limit.js';
import { contactRetryAfter, recordContactAttempt } from './contact.limit.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { enqueueEmail } from '../email/outbox.js';
import { contactConfirm, contactTeamNotice, contactAck } from '../email/templates-contact.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

export const contactRoutes = new OpenAPIHono();

const J = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

// 24h link lifetime — same as the legacy TOKEN_MAX_AGE_MS.
const LINK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Per-address mailbomb guard: at most one confirmation email per address per
// hour per store, checked inside the transaction — the same guard the
// subscriber signup applies via last_sent_at (the per-IP throttle alone does
// not stop a distributed attacker mailbombing a victim's inbox).
const CONFIRM_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Signing secret for the confirm link. Resolution order mirrors the legacy
 * plugin's LICENSING_HMAC_SECRET || COOKIE_SECRET chain, extended with the
 * repo's own DOWNLOAD_URL_SECRET. Last resort is a per-process random key —
 * links break on restart, which is strictly better than a hardcoded public
 * secret that lets anyone forge a confirm link and spam the team inbox.
 * Configure CONTACT_FORM_SECRET (or any earlier fallback) in real deploys.
 */
const CONTACT_LINK_SECRET =
  env.CONTACT_FORM_SECRET ?? process.env.CONTACT_FORM_SECRET ??
  env.LICENSING_HMAC_SECRET ?? process.env.LICENSING_HMAC_SECRET ??
  env.COOKIE_SECRET ?? process.env.COOKIE_SECRET ??
  env.DOWNLOAD_URL_SECRET ??
  randomBytes(32).toString('hex');

function signConfirm(id: string, ts: number): string {
  return createHmac('sha256', CONTACT_LINK_SECRET).update(`${id}:${ts}`).digest('hex');
}

/** Exported for tests + the email builder. URL shape mirrors the legacy `?data&ts&sig` link, minus the in-URL payload. */
export function buildConfirmUrl(base: string, storeSlug: string, id: string, ts: number): string {
  const sig = signConfirm(id, ts);
  return `${base.replace(/\/$/, '')}/v1/shop/contact/confirm?id=${id}&s=${encodeURIComponent(storeSlug)}&ts=${ts}&sig=${sig}`;
}

type StoreConfig = Record<string, unknown> | null;

const asConfig = (config: unknown): StoreConfig =>
  (config && typeof config === 'object' ? config : null) as StoreConfig;

/** Per-store team inbox for delivered contact submissions. */
function contactRecipient(raw: unknown): string {
  const config = asConfig(raw);
  const notifications = (config?.notifications ?? {}) as Record<string, unknown>;
  const candidate =
    (typeof notifications.contactEmail === 'string' && notifications.contactEmail) ||
    (typeof config?.contactEmail === 'string' && config.contactEmail) ||
    env.CONTACT_EMAIL || process.env.CONTACT_EMAIL ||
    env.SMTP_FROM;
  return candidate;
}

/** Per-store Turnstile secret; null when the feature is off for this store. */
export function turnstileSecret(raw: unknown): string | null {
  const config = asConfig(raw);
  const t = config?.turnstile as Record<string, unknown> | undefined;
  const candidate =
    (typeof config?.turnstileSecret === 'string' && config.turnstileSecret) ||
    (typeof config?.turnstileSecretKey === 'string' && config.turnstileSecretKey) ||
    (typeof config?.turnstile_secret_key === 'string' && config.turnstile_secret_key) ||
    (t && typeof t.secretKey === 'string' ? t.secretKey : '') ||
    env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY ||
    '';
  return candidate || null;
}

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
   <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 24px;color:#222">
     <h2 style="margin:0 0 12px">${title}</h2>
     <p style="line-height:1.5">${body}</p>
   </body></html>`;

const ContactIn = z.object({
  // Trim before validating — same reasoning as the newsletter email field.
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().pipe(z.email()).pipe(z.string().max(320)),
  subject: z.string().trim().min(1).max(500),
  message: z.string().trim().min(1).max(5000),
  turnstileToken: z.string().optional(),
  // Honeypots: real users never fill hidden fields; either name accepted so
  // storefronts can keep their existing markup.
  honeypot: z.string().optional(),
  website: z.string().optional(),
});

// ── POST /v1/shop/contact ──────────────────────────────────────────────────
contactRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/contact', summary: 'Submit the contact form (emails a signed confirm link)',
    request: { body: { content: J(ContactIn) } },
    responses: {
      200: { description: 'Accepted — confirmation email queued', content: J(z.object({ ok: z.boolean(), message: z.string().optional() })) },
      400: { description: 'Invalid or failed security check', content: J(z.object({ error: z.string() })) },
      429: { description: 'Rate limited', content: J(z.object({ error: z.string() })) },
    },
  }),
  async (c) => {
    const body = c.req.valid('json') as z.infer<typeof ContactIn>;

    // Honeypot first: a filled hidden field is a bot. Fake-success so the bot
    // learns nothing — same contract as the source plugin.
    if (body.honeypot || body.website) {
      return c.json({ ok: true, message: 'Check your email to confirm your submission.' }, 200);
    }

    const ip = clientIp(c);
    const retry = contactRetryAfter(ip);
    if (retry > 0) return c.json({ error: `too many submissions — try again in ${retry}s` }, 429);
    recordContactAttempt(ip);

    const st = await resolveStoreFromCtx(c);

    // Turnstile: required when a secret is configured for this store (env or
    // store config); verifyTurnstileToken returns true unconditionally when
    // unconfigured, and fails closed on any error when configured.
    const ok = await verifyTurnstileToken({ secret: turnstileSecret(st.config), token: body.turnstileToken, remoteIp: ip });
    if (!ok) return c.json({ error: 'security verification failed — please try again' }, 400);

    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();
    const subject = body.subject.trim();
    const message = body.message.trim();

    // Persist + enqueue the confirmation email in ONE transaction (the
    // subscriber pattern): a rolled-back insert leaves no dangling email,
    // and a missing email never leaves an undeliverable pending row.
    await withStore(st.id, async (tx) => {
      const recent = await tx.execute(
        sql`SELECT id FROM contact_submission
            WHERE store_id = ${st.id} AND email = ${email} AND created_at > ${new Date(Date.now() - CONFIRM_COOLDOWN_MS)}
            LIMIT 1`,
      );
      if (recent.rows.length) return; // cooldown — silently accepted, no second email

      const inserted = await tx.execute(
        sql`INSERT INTO contact_submission (store_id, name, email, subject, message, remote_ip)
            VALUES (${st.id}, ${name}, ${email}, ${subject}, ${message}, ${ip})
            RETURNING id`,
      );
      const id = (inserted.rows[0] as { id: string }).id;
      const confirmUrl = buildConfirmUrl(env.STOREFRONT_URL, st.slug, id, Date.now());
      const ctx = { name: st.name, currency: st.currency, storefrontUrl: env.STOREFRONT_URL, fromEmail: env.SMTP_FROM };
      const rendered = contactConfirm(ctx, { name, subject, confirmUrl });
      await enqueueEmail(tx, st.id, {
        kind: 'contact_confirm',
        recipient: email,
        payload: { to: email, from: ctx.fromEmail, ...rendered },
      });
    });

    return c.json({ ok: true, message: 'Check your email to confirm your submission.' }, 200);
  },
);

// ── GET /v1/shop/contact/confirm?id&s&ts&sig ───────────────────────────────
// The signed link from the confirmation email. First valid click claims the
// submission (pending→delivered atomically) and enqueues the team delivery +
// customer acknowledgment in the same transaction. Later clicks, mail-
// scanner prefetches, and replays get the same success page with no re-send.
contactRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/contact/confirm',
    summary: 'Confirm a contact submission (signed link)',
    request: {
      query: z.object({
        id: z.string().uuid(),
        s: z.string().optional(), // store slug — keeps the link tenant-correct on multi-host stores
        ts: z.coerce.number().int().positive(),
        sig: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    },
    responses: {
      200: { description: 'Confirmed (or already confirmed)', content: { 'text/html': { schema: z.string() } } },
      400: { description: 'Malformed link', content: { 'text/html': { schema: z.string() } } },
      403: { description: 'Bad signature', content: { 'text/html': { schema: z.string() } } },
      410: { description: 'Expired link', content: { 'text/html': { schema: z.string() } } },
    },
  }),
  async (c) => {
    const { id, s: slug, ts, sig } = c.req.valid('query');

    // Signature first — never touch the DB for an unauthenticated link.
    const expected = signConfirm(id, ts);
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return c.html(html('Invalid link', 'This confirmation link is invalid or has been tampered with.'), 403);
    }
    const age = Date.now() - ts;
    if (age > LINK_MAX_AGE_MS || age < -5 * 60 * 1000) {
      return c.html(html('Link expired', 'This confirmation link has expired. Please submit the form again.'), 410);
    }

    // Resolve the tenant from the link's slug when present (config-generated
    // and therefore trusted); otherwise fall back to request resolution.
    const st = slug
      ? await resolveStore(slug).catch(() => null)
      : await resolveStoreForRequest({
          storeSlugHeader: c.req.header('x-store-slug'),
          host: c.req.header('host'),
          forwardedHost: c.req.header('x-forwarded-host'),
        }).catch(() => null);
    if (!st) return c.html(html('Invalid link', 'This confirmation link is invalid.'), 400);

    const delivered = await withStore(st.id, async (tx: Tx) => {
      const claimed = await tx.execute(
        sql`UPDATE contact_submission
            SET status = 'delivered', delivered_at = now(), updated_at = now()
            WHERE id = ${id} AND status = 'pending'
            RETURNING name, email, subject, message`,
      );
      const row = claimed.rows[0] as { name: string; email: string; subject: string; message: string } | undefined;
      if (!row) return false; // unknown id under this tenant, or already delivered

      const ctx = { name: st.name, currency: st.currency, storefrontUrl: env.STOREFRONT_URL, fromEmail: env.SMTP_FROM };
      const team = contactRecipient(st.config);
      const notice = contactTeamNotice(ctx, row);
      await enqueueEmail(tx, st.id, {
        kind: 'contact_team',
        recipient: team,
        payload: { to: team, from: ctx.fromEmail, ...notice },
      });
      const ack = contactAck(ctx, { name: row.name, subject: row.subject });
      await enqueueEmail(tx, st.id, {
        kind: 'contact_ack',
        recipient: row.email,
        payload: { to: row.email, from: ctx.fromEmail, ...ack },
      });
      return true;
    });

    if (!delivered) log.info('contact confirm: duplicate click or unknown id', { submission: id });
    return c.html(html('Message confirmed', "Your message has been confirmed and delivered. We'll get back to you soon."), 200);
  },
);
