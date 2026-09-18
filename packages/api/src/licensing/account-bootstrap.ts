/**
 * Purchase → account bootstrap. A *configured* purchase attaches or creates a
 * passwordless customer account, associates the order's issued entitlements
 * (licenses) with it, and enqueues a one-time claim mail through the
 * transactional outbox — exactly once per order.
 *
 * Ported upstream from RightSites' licensing/account-bootstrap.ts and
 * genericized:
 *
 *  - Trigger is catalog config, not a hard-coded app key: an order qualifies
 *    when a purchased line's product OR variant carries
 *    `metafields.softwareAccount === true` (same "arbitrary app data" JSONB
 *    convention as product.metafields.facetValueIds). Stores/apps opt in per
 *    product; every other checkout keeps the pre-existing guest behavior.
 *  - Contact email comes from `order.metadata.contact.email` — SellRight's
 *    existing checkout capture (routes/checkout.ts); there is no
 *    order.contact_email column here.
 *  - The mailed credential is a customer_token row of kind 'set_password'
 *    (already in the kind CHECK, migration 0023) carrying a one-time claim
 *    link — never a session. Capturing an email at checkout is NOT proof of
 *    mailbox ownership, so nobody is auto-logged-in and the account stays
 *    emailVerified=false until the link is consumed.
 *  - Sender + storefront URL resolve per store via the SR-05 tenant resolver
 *    (store.config → per-app env map → global env). The downstream version's
 *    global-sender/global-URL defect is deliberately not ported.
 *
 * Choke points: every ASYNC settlement funnels through the Paid-transition
 * branch in payments/settle.ts → enqueuePaidEffects() (payments/paid-effects.ts),
 * which calls bootstrapAccountAndQueueAccessMail. The synchronous checkout
 * settle paths (zero-total order, full gift-card cover) never reach settle.ts,
 * so routes/checkout.ts calls the same entrypoint inside its `paid` block.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';
import { enqueueEmail } from '../email/outbox.js';
import {
  pickEmailAppKey,
  resolveFromEmail,
  resolveStorefrontUrl,
  type StoreEmailCtx,
} from '../email/dispatch.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Lifetime of the mailed claim/set-password link. Deliberately generous: it
 *  rides the purchase receipt, and an expired link is recoverable through the
 *  ordinary forgot-password flow (the account already exists by then). */
const CLAIM_TOKEN_TTL_HOURS = 72;

/** Outbox kind for the purchase-claim mail. */
export const ACCOUNT_ACCESS_KIND = 'account_access';

export interface AccountBootstrapResult {
  customerId: string;
  email: string;
  isNewAccount: boolean;
  /** appKeys of the flagged lines — feeds per-app sender/URL resolution. */
  appKeys: string[];
}

/** Catalog flag read: `metafields.softwareAccount === true` opts a product or
 *  variant into purchase-bootstrapped accounts. Anything else (missing, false,
 *  non-boolean, non-object metafields) is off. */
export function softwareAccountRequested(metafields: unknown): boolean {
  if (!metafields || typeof metafields !== 'object') return false;
  return (metafields as { softwareAccount?: unknown }).softwareAccount === true;
}

/** Idempotent: an order that already carries a customerId (session checkout,
 *  email-match link, or a prior bootstrap) is a no-op — this is the exactly-
 *  once guarantee under settlement retry. Only fires when a purchased line is
 *  flagged `softwareAccount` and the order captured a contact email. */
export async function ensurePasswordlessAccountForOrder(
  tx: Tx,
  input: { storeId: string; orderId: string; existingCustomerId: string | null },
): Promise<AccountBootstrapResult | null> {
  // Re-read + lock the order row rather than trusting the caller's snapshot:
  // the row lock serializes concurrent settle/bootstrap attempts, and the
  // freshly-read customerId is the authoritative idempotency check.
  const [order] = await tx
    .select({ customerId: s.order.customerId, metadata: s.order.metadata })
    .from(s.order)
    .where(eq(s.order.id, input.orderId))
    .limit(1)
    .for('update');
  if (!order) return null;
  if (order.customerId ?? input.existingCustomerId) return null;

  const email = normalizeEmail(
    (order.metadata as { contact?: { email?: string } } | null)?.contact?.email ?? '',
  );
  if (!email) return null;

  const lines = await tx
    .select({
      orderLineId: s.orderLine.id,
      appKey: s.productVariant.appKey,
      variantMetafields: s.productVariant.metafields,
      productMetafields: s.product.metafields,
    })
    .from(s.orderLine)
    .innerJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
    .innerJoin(s.product, eq(s.product.id, s.productVariant.productId))
    .where(eq(s.orderLine.orderId, input.orderId));
  const flagged = lines.filter(
    (l) => softwareAccountRequested(l.variantMetafields) || softwareAccountRequested(l.productMetafields),
  );
  if (!flagged.length) return null;

  const [existing] = await tx
    .select({ id: s.customer.id })
    .from(s.customer)
    .where(and(eq(s.customer.storeId, input.storeId), eq(s.customer.email, email)))
    .limit(1);

  let customerId: string;
  let isNewAccount: boolean;
  if (existing) {
    customerId = existing.id;
    isNewAccount = false;
  } else {
    // Passwordless: passwordHash stays null (same shape as a Vendure-migrated
    // customer). emailVerified stays false until the claim link is consumed.
    // onConflictDoNothing + reselect covers a concurrent bootstrap for a
    // different order hitting the same address — the loser links the winner's
    // row instead of erroring the settlement txn.
    const [created] = await tx
      .insert(s.customer)
      .values({ storeId: input.storeId, email, emailVerified: false })
      .onConflictDoNothing()
      .returning({ id: s.customer.id });
    if (created) {
      customerId = created.id;
      isNewAccount = true;
    } else {
      const [winner] = await tx
        .select({ id: s.customer.id })
        .from(s.customer)
        .where(and(eq(s.customer.storeId, input.storeId), eq(s.customer.email, email)))
        .limit(1);
      if (!winner) throw new Error('passwordless account bootstrap insert returned no id');
      customerId = winner.id;
      isNewAccount = false;
    }
  }

  await tx.update(s.order).set({ customerId, updatedAt: new Date() }).where(eq(s.order.id, input.orderId));
  // Associate the order's entitlements. Licenses were issued (possibly with a
  // null customerId) by issueLicensesForPaidOrder earlier in the same settle;
  // only unattributed rows are claimed — never clobber an existing owner.
  await tx
    .update(s.license)
    .set({ customerId, updatedAt: new Date() })
    .where(and(eq(s.license.orderId, input.orderId), isNull(s.license.customerId)));

  return {
    customerId,
    email,
    isNewAccount,
    appKeys: [...new Set(flagged.map((l) => l.appKey).filter((k): k is string => !!k))],
  };
}

/** Minimal house-style renderer (mirrors templates.ts wrap(): bracketed store
 *  subject, escaped body, text fallback). Kept local so this module doesn't
 *  edit email/templates.ts, which another lane owns. */
function accountAccessMail(
  storeName: string,
  data: { url: string; ttlHours: number; isNewAccount: boolean },
): { subject: string; html: string; text: string } {
  const escapeHtml = (v: string) =>
    v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const title = data.isNewAccount ? 'Your account is ready' : 'Your purchase is linked to your account';
  const lead = data.isNewAccount
    ? `Your purchase created a ${escapeHtml(storeName)} account for this email. Set a password within ${data.ttlHours} hours to claim it — the link works once.`
    : `Your purchase was linked to the ${escapeHtml(storeName)} account for this email. Use the link below within ${data.ttlHours} hours to access it — it works once.`;
  const body = `<p>${lead}</p>
    <p><a href="${escapeHtml(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Access your account</a></p>
    <p>If you didn't make this purchase, ignore this email.</p>`;
  return {
    subject: `[${storeName}] ${title}`.replace(/[\r\n]+/g, ' '),
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
    <h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="color:#888;font-size:12px">${escapeHtml(storeName)}</p>
  </body></html>`,
    text: `${title}\n\n${lead} ${data.url}\n\n— ${storeName}`,
  };
}

/** Settlement call-site wrapper: bootstrap the account (if applicable) AND
 *  mint + enqueue the one-time claim mail through the durable outbox in one
 *  call, so every paid path (settle.ts via enqueuePaidEffects, checkout's
 *  synchronous paid branches) shares the same plumbing.
 *
 *  Exactly-once: the bootstrap no-ops once the order has a customerId, and the
 *  outbox row is dedupeKey'd per order — a replayed settle cannot re-mint a
 *  token or double-mail the customer. No SMTP here; the scheduler delivers. */
export async function bootstrapAccountAndQueueAccessMail(
  tx: Tx,
  input: { storeId: string; orderId: string; existingCustomerId: string | null },
): Promise<AccountBootstrapResult | null> {
  const bootstrap = await ensurePasswordlessAccountForOrder(tx, input);
  if (!bootstrap) return null;

  const raw = randomBytes(32).toString('base64url');
  await tx.insert(s.customerToken).values({
    storeId: input.storeId,
    customerId: bootstrap.customerId,
    kind: 'set_password',
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_HOURS * 3600 * 1000),
  });

  const [storeRow] = await tx
    .select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store)
    .where(eq(s.store.id, input.storeId))
    .limit(1);
  const appKey = pickEmailAppKey(bootstrap.appKeys);
  const ctx: StoreEmailCtx = {
    name: storeRow?.name ?? 'Store',
    currency: storeRow?.currency ?? 'USD',
    appKey,
    config: storeRow?.config,
  };
  const url = `${resolveStorefrontUrl(ctx)}/set-password?token=${raw}`;
  const rendered = accountAccessMail(ctx.name, {
    url,
    ttlHours: CLAIM_TOKEN_TTL_HOURS,
    isNewAccount: bootstrap.isNewAccount,
  });
  await enqueueEmail(tx, input.storeId, {
    kind: ACCOUNT_ACCESS_KIND,
    dedupeKey: `${ACCOUNT_ACCESS_KIND}:${input.orderId}`,
    recipient: bootstrap.email,
    payload: {
      to: bootstrap.email,
      from: resolveFromEmail(ctx),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    },
  });
  return bootstrap;
}
