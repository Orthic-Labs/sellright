/**
 * Ops-lane email templates (PAR-07 dispute alerts + affiliate welcome/rotation).
 * Lives separately from templates.ts (owned by another lane) — same contract:
 * a template returns {subject, html, text} and the caller sends/enqueues it
 * via the existing outbox/dispatch API.
 */
import { renderEmailShell, colorsOf, type StoreCtx } from './layout.js';

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const wrap = (store: StoreCtx, title: string, body: string) => renderEmailShell(store, title, body);

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
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Provider</td><td>${escape(data.provider)}</td></tr>
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Reference</td><td>${escape(data.providerRef)}</td></tr>
       ${data.orderCode ? `<tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Order</td><td>${escape(data.orderCode)}</td></tr>` : ''}
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Amount</td><td>${escape(money(data.amountCents, data.currency))}</td></tr>
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Reason</td><td>${escape(data.reason ?? 'No reason supplied')}</td></tr>
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Status</td><td>${escape(data.status)}</td></tr>
     </table>`);

/** Affiliate welcome (first onboard) — DD's AffiliateWelcomeEvent mail. */
export const affiliateWelcome = (store: StoreCtx, data: {
  code: string; dashboardUrl: string; accessUrl: string;
}) =>
  wrap(store, `Your affiliate dashboard is ready — code ${data.code}`,
    `<p>You're set up as a ${escape(store.name)} affiliate. Share your coupon code <strong>${escape(data.code)}</strong> — you earn commission on every settled order that uses it.</p>
     <p><a href="${escape(data.accessUrl)}" style="display:inline-block;padding:10px 16px;background:${colorsOf(store).button};color:${colorsOf(store).buttonText};text-decoration:none;border-radius:6px">Open your dashboard</a></p>
     <p>Your dashboard link (keep it private — it IS the credential): ${escape(data.accessUrl)}</p>`);

/** Affiliate recipient changed — the token rotated; the old link is dead. */
export const affiliateTokenRotated = (store: StoreCtx, data: {
  code: string; dashboardUrl: string; accessUrl: string;
}) =>
  wrap(store, `Your ${store.name} affiliate link changed — code ${data.code}`,
    `<p>This affiliate coupon (<strong>${escape(data.code)}</strong>) was reassigned to you. For security the previous access link was revoked — use the new one below.</p>
     <p><a href="${escape(data.accessUrl)}" style="display:inline-block;padding:10px 16px;background:${colorsOf(store).button};color:${colorsOf(store).buttonText};text-decoration:none;border-radius:6px">Open your dashboard</a></p>
     <p>Your new dashboard link: ${escape(data.accessUrl)}</p>`);

/** Operator alert for payment money that needs manual reconciliation
 *  (payments audit D3/D4/D14): captured funds that could not be applied to the
 *  order automatically. Never auto-refunded — review in the gateway dashboard. */
export const paymentAlert = (store: StoreCtx, data: {
  kind: string;
  title: string;
  provider: string;
  providerRef: string | null;
  orderCode: string | null;
  amountCents: number | null;
  currency: string | null;
  detail: string;
}) =>
  wrap(store, `${data.title} — ${data.orderCode ?? data.providerRef ?? 'payment'}`,
    `<p>${escape(data.detail)}</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Alert</td><td>${escape(data.kind)}</td></tr>
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Provider</td><td>${escape(data.provider)}</td></tr>
       ${data.providerRef ? `<tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Reference</td><td>${escape(data.providerRef)}</td></tr>` : ''}
       ${data.orderCode ? `<tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Order</td><td>${escape(data.orderCode)}</td></tr>` : ''}
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Amount</td><td>${escape(money(data.amountCents, data.currency))}</td></tr>
     </table>
     <p>It is listed under Payment reconciliation in the admin.</p>`);

/** D14: operator alert — money settled on an order that could no longer be
 *  paid (e.g. a gateway capture landing after the stale sweeper cancelled it).
 *  Needs a human: refund the customer or reinstate the order. */
export const paymentAfterCancelAlert = (store: StoreCtx, data: {
  orderCode: string | null;
  orderState: string;
  method: string;
  providerRef: string | null;
  amountCents: number;
  currency: string | null;
}) =>
  wrap(store, `Payment received on ${data.orderState.toLowerCase()} order ${data.orderCode ?? ''}`.trim(),
    `<p>A ${escape(data.method)} payment settled against an order that is <strong>${escape(data.orderState)}</strong>, so it was not marked paid. The money was recorded in the payment ledger. Refund the customer or restore the order, then resolve it under Payment reconciliation.</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">
       ${data.orderCode ? `<tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Order</td><td>${escape(data.orderCode)}</td></tr>` : ''}
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Method</td><td>${escape(data.method)}</td></tr>
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Reference</td><td>${escape(data.providerRef ?? 'none')}</td></tr>
       <tr><td style="padding:4px 0;color:${colorsOf(store).muted}">Amount</td><td>${escape(money(data.amountCents, data.currency))}</td></tr>
     </table>`);
