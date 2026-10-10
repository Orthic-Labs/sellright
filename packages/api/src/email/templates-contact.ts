/**
 * Email templates for PAR-01 (contact form) + PAR-05 (back-in-stock).
 *
 * Lives beside templates.ts rather than inside it because that file is owned
 * by another lane. Same shape: plain functions returning {subject, html,
 * text}. The shell (wrap) is the shared renderEmailShell in layout.ts, so the
 * per-store theme tokens apply here too.
 */
import { renderEmailShell, colorsOf, type StoreCtx } from './layout.js';

const wrap = (store: StoreCtx, title: string, body: string) => renderEmailShell(store, title, body);

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// PAR-01: confirm-before-deliver. Sent to the SUBMITTER, not an account OTP —
// clicking the signed link is what releases the message to the team inbox.
export const contactConfirm = (store: StoreCtx, data: {
  name: string;
  subject: string;
  confirmUrl: string;
}) =>
  wrap(store, 'Confirm your submission',
    `<p>Hi ${escape(data.name)}, you submitted a message to ${escape(store.name)} about <strong>${escape(data.subject)}</strong>.</p>
     <p>Please confirm your email address to deliver it to our team:</p>
     <p><a href="${escape(data.confirmUrl)}" style="display:inline-block;padding:10px 16px;background:${colorsOf(store).button};color:${colorsOf(store).buttonText};text-decoration:none;border-radius:6px">Confirm my submission</a></p>
     <p>Or paste this link into your browser:<br><span style="color:${colorsOf(store).muted};font-size:12px;word-break:break-all">${escape(data.confirmUrl)}</span></p>
     <p>The link expires in 24 hours. If you didn't submit this form, ignore this email — nothing will be delivered.</p>`);

// PAR-01: the team inbox copy, sent once on the first valid confirm click.
// The submitter's email goes in the body — SendEmailInput has no replyTo
// field, so the address must be visible in the message itself.
export const contactTeamNotice = (store: StoreCtx, data: {
  name: string;
  email: string;
  subject: string;
  message: string;
}) =>
  wrap(store, `Contact Form: ${data.subject}`,
    `<p><strong>From:</strong> ${escape(data.name)} &lt;${escape(data.email)}&gt;</p>
     <p><strong>Subject:</strong> ${escape(data.subject)}</p>
     <p style="white-space:pre-wrap">${escape(data.message)}</p>`);

// PAR-01: customer acknowledgment, enqueued with the team delivery.
export const contactAck = (store: StoreCtx, data: { name: string; subject: string }) =>
  wrap(store, 'We received your message',
    `<p>Hi ${escape(data.name)}, thanks for contacting ${escape(store.name)} — we've received your message about <strong>${escape(data.subject)}</strong> and will get back to you soon.</p>`);

// PAR-05: one-shot restock notification. Includes the cancel link so the
// request can be revoked — consent for a single transactional email, not a
// subscription.
export const restockNotify = (store: StoreCtx, data: {
  productName: string;
  variantName: string;
  productUrl: string;
  cancelUrl: string;
}) =>
  wrap(store, `Back in stock: ${data.productName}`,
    `<p>Good news — <strong>${escape(data.productName)}</strong> (${escape(data.variantName)}) is back in stock at ${escape(store.name)}.</p>
     <p><a href="${escape(data.productUrl)}" style="display:inline-block;padding:10px 16px;background:${colorsOf(store).button};color:${colorsOf(store).buttonText};text-decoration:none;border-radius:6px">View product</a></p>
     <p style="color:${colorsOf(store).footer};font-size:12px">You asked to be notified once when this came back. This is that one email — or <a href="${escape(data.cancelUrl)}">cancel the request</a> if it already landed twice.</p>`);
