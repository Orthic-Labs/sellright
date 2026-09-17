/**
 * Ops-lane email templates (PAR-07 dispute alerts + affiliate welcome/rotation).
 * Lives separately from templates.ts (owned by another lane) — same contract:
 * a template returns {subject, html, text} and the caller sends/enqueues it
 * via the existing outbox/dispatch API.
 */
import type { StoreCtx } from './templates.js';

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

const wrap = (store: StoreCtx, title: string, body: string) => ({
  // Strip CR/LF from the subject — SMTP header-injection guard (see templates.ts).
  subject: `[${store.name}] ${title}`.replace(/[\r\n]+/g, ' '),
  html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
    <h2 style="margin:0 0 16px">${escape(title)}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="color:#888;font-size:12px">${escape(store.name)}</p>
  </body></html>`,
  text: `${title}\n\n${stripTags(body)}\n\n— ${store.name}`,
});

const money = (cents: number | null, currency: string | null) =>
  cents == null ? 'unknown amount' : `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim();

/** PAR-07: operator alert for a recorded dispute/chargeback (Stripe or NMI).
 *  Mirrors DD's nmi-chargeback-alert handler fields: order code, transaction/
 *  dispute id, amount, reason, outcome note. */
export const disputeAlert = (store: StoreCtx, data: {
  provider: string;
  providerRef: string;
  orderCode: string | null;
  amountCents: number | null;
  currency: string | null;
  reason: string | null;
  status: string;
}) =>
  wrap(store, `Chargeback/dispute opened — ${data.orderCode ?? data.providerRef}`,
    `<p>A ${escape(data.provider)} dispute was recorded${data.orderCode ? ` against order <strong>${escape(data.orderCode)}</strong>` : ''}. Disputes are never auto-refunded or auto-cancelled — review and respond in the ${escape(data.provider)} dashboard.</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">
       <tr><td style="padding:4px 0;color:#666">Provider</td><td>${escape(data.provider)}</td></tr>
       <tr><td style="padding:4px 0;color:#666">Reference</td><td>${escape(data.providerRef)}</td></tr>
       ${data.orderCode ? `<tr><td style="padding:4px 0;color:#666">Order</td><td>${escape(data.orderCode)}</td></tr>` : ''}
       <tr><td style="padding:4px 0;color:#666">Amount</td><td>${escape(money(data.amountCents, data.currency))}</td></tr>
       <tr><td style="padding:4px 0;color:#666">Reason</td><td>${escape(data.reason ?? 'No reason supplied')}</td></tr>
       <tr><td style="padding:4px 0;color:#666">Status</td><td>${escape(data.status)}</td></tr>
     </table>`);

/** Affiliate welcome (first onboard) — DD's AffiliateWelcomeEvent mail. */
export const affiliateWelcome = (store: StoreCtx, data: {
  code: string; dashboardUrl: string; accessUrl: string;
}) =>
  wrap(store, `Your affiliate dashboard is ready — code ${data.code}`,
    `<p>You're set up as a ${escape(store.name)} affiliate. Share your coupon code <strong>${escape(data.code)}</strong> — you earn commission on every settled order that uses it.</p>
     <p><a href="${escape(data.accessUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Open your dashboard</a></p>
     <p>Your dashboard link (keep it private — it IS the credential): ${escape(data.accessUrl)}</p>`);

/** Affiliate recipient changed — the token rotated; the old link is dead. */
export const affiliateTokenRotated = (store: StoreCtx, data: {
  code: string; dashboardUrl: string; accessUrl: string;
}) =>
  wrap(store, `Your ${store.name} affiliate link changed — code ${data.code}`,
    `<p>This affiliate coupon (<strong>${escape(data.code)}</strong>) was reassigned to you. For security the previous access link was revoked — use the new one below.</p>
     <p><a href="${escape(data.accessUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Open your dashboard</a></p>
     <p>Your new dashboard link: ${escape(data.accessUrl)}</p>`);
