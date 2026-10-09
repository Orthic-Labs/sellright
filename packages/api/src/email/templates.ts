/**
 * Email templates (WP2b). Plain TS functions — no template engine dep. Each
 * returns {subject, html, text} so the mailer stays dumb.
 */
import { textBody as stripTags } from './text-body.js';

export interface StoreCtx { name: string; currency: string; storefrontUrl: string; fromEmail: string; }

const wrap = (store: StoreCtx, title: string, body: string) => ({
  // Strip CR/LF from the subject — titles interpolate caller data (e.g. the
  // inviter's email in staffInvite); a newline would otherwise allow SMTP
  // header injection. (HTML-escaping is wrong for a subject; it's not HTML.)
  subject: `[${store.name}] ${title}`.replace(/[\r\n]+/g, ' '),
  html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
    <h2 style="margin:0 0 16px">${escape(title)}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="color:#888;font-size:12px">${escape(store.name)}</p>
  </body></html>`,
  text: `${title}\n\n${stripTags(body)}\n\n— ${store.name}`,
});

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const orderConfirmation = (store: StoreCtx, data: { code: string; grandTotal: number; currency: string; lines: Array<{ name: string; quantity: number; lineTotal: number }> }) =>
  wrap(store, `Order confirmed — ${data.code}`,
    `<p>Thanks for your order. Here's the summary:</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">${data.lines.map((l) => `<tr><td>${escape(l.name)} × ${l.quantity}</td><td style="text-align:right">${(l.lineTotal / 100).toFixed(2)} ${escape(data.currency)}</td></tr>`).join('')}</table>
     <p><strong>Total: ${(data.grandTotal / 100).toFixed(2)} ${escape(data.currency)}</strong></p>
     <p>Track your order at <a href="${escape(store.storefrontUrl)}/orders/${escape(data.code)}">${escape(store.storefrontUrl)}/orders/${escape(data.code)}</a></p>`);

export const shippingNotification = (store: StoreCtx, data: { code: string; trackingCode: string | null; carrier: string | null }) =>
  wrap(store, `Your order ${data.code} is on the way`,
    `<p>${data.carrier ? `Carrier: <strong>${escape(data.carrier)}</strong><br>` : ''}${data.trackingCode ? `Tracking: <strong>${escape(data.trackingCode)}</strong>` : ''}</p>
     <p>Track at <a href="${escape(store.storefrontUrl)}/orders/${escape(data.code)}">${escape(store.storefrontUrl)}/orders/${escape(data.code)}</a></p>`);

// PAR-03: refund confirmation. Enqueued ONLY at definitive settlement (the
// caller's job — see payments/refunds finalize); the copy always describes a
// completed refund, so it must never be rendered for a Pending/unknown result.
// `refundedTotal` is the cumulative settled amount vs the order's grandTotal,
// which is what distinguishes a partial refund from a full one in the copy.
export const orderRefundConfirmation = (store: StoreCtx, data: {
  code: string;
  amount: number;        // this refund, cents
  currency: string;
  refundedTotal: number; // cumulative settled refunds on the order, cents
  grandTotal: number;    // order grand total, cents
}) => {
  const full = data.refundedTotal >= data.grandTotal;
  return wrap(store, `Refund issued for order ${data.code}`,
    `<p>A refund of <strong>${(data.amount / 100).toFixed(2)} ${escape(data.currency)}</strong> has been issued for your order <strong>${escape(data.code)}</strong>.</p>
     <p>${full
       ? `This fully refunds the order total of ${(data.grandTotal / 100).toFixed(2)} ${escape(data.currency)}.`
       : `Total refunded so far: ${(data.refundedTotal / 100).toFixed(2)} ${escape(data.currency)} of ${(data.grandTotal / 100).toFixed(2)} ${escape(data.currency)}.`}</p>
     <p>View your order at <a href="${escape(store.storefrontUrl)}/orders/${escape(data.code)}">${escape(store.storefrontUrl)}/orders/${escape(data.code)}</a></p>`);
};

// emailAddressChangeHandler parity: the verification link goes to the NEW
// address (proving the customer controls it) and is single-use + TTL'd.
export const emailAddressChange = (store: StoreCtx, data: { url: string; newEmail: string; ttlHours: number }) =>
  wrap(store, 'Confirm your new email address',
    `<p>You asked to change the email address on your ${escape(store.name)} account to <strong>${escape(data.newEmail)}</strong>. Confirm within ${data.ttlHours} hours:</p>
     <p><a href="${escape(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Confirm new email</a></p>
     <p>If you didn't request this, ignore this email — your sign-in address stays the same.</p>`);

// Security notice sent to the OLD address once an email-address change is
// CONFIRMED (not on request — only after the new address proved control).
// Independent of consent/session state: if an attacker used a hijacked
// session to change the sign-in address, the rightful owner still receives
// this at the address they can actually read, with a support contact.
export const emailAddressChangedNotice = (store: StoreCtx, data: { newEmail: string }) =>
  wrap(store, 'Your account email address was changed',
    `<p>The sign-in email address on your ${escape(store.name)} account was changed to <strong>${escape(data.newEmail)}</strong>.</p>
     <p>If you made this change, no action is needed.</p>
     <p><strong>If you did not make this change</strong>, someone else may have access to your account — contact support immediately.</p>`);

export const passwordReset = (store: StoreCtx, data: { url: string; ttlHours: number }) =>
  wrap(store, 'Reset your password',
    `<p>Someone (hopefully you) asked to reset your password. Click below within ${data.ttlHours} hours:</p>
     <p><a href="${escape(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Reset password</a></p>
     <p>If you didn't ask, ignore this email — your password stays the same.</p>`);

export const emailVerify = (store: StoreCtx, data: { url: string }) =>
  wrap(store, 'Verify your email',
    `<p>Welcome! Please confirm your email address:</p>
     <p><a href="${escape(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Verify email</a></p>`);

// Passwordless sign-in (ported from RightSites). Sent when a customer asks for
// a sign-in link — and downstream flows may pass isNewAccount when the account
// was created implicitly (e.g. by a purchase), so the copy can say so.
export const magicLinkAccess = (store: StoreCtx, data: { url: string; ttlMinutes: number; isNewAccount: boolean }) =>
  wrap(store, data.isNewAccount ? `Your ${store.name} account is ready` : 'Sign in to your account',
    `<p>${data.isNewAccount
      ? `Your ${escape(store.name)} account is ready — no password needed. Use the link below within ${data.ttlMinutes} minutes to access your account.`
      : `Use this link within ${data.ttlMinutes} minutes to sign in to your ${escape(store.name)} account. No password needed.`}</p>
     <p><a href="${escape(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Sign in</a></p>
     <p>If you didn't request this, you can ignore this email.</p>`);

export const staffInvite = (store: StoreCtx, data: { acceptUrl: string; role: string; inviterEmail: string }) =>
  wrap(store, `${data.inviterEmail} invited you to ${store.name}`,
    `<p>You've been invited to help manage <strong>${escape(store.name)}</strong> as a <strong>${escape(data.role)}</strong>.</p>
     <p><a href="${escape(data.acceptUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Accept invite</a></p>`);

// Free-trial license key delivery (licensing/trial.ts). The key is emailed,
// never returned in the API response, so an unreceived/throwaway address
// can't mint a working trial (see routes/apps.ts POST /licenses/trial).
export const trialLicenseKey = (store: StoreCtx, data: { key: string; days: number; pricingUrl: string }) =>
  wrap(store, `Your ${data.days}-day Pro key`,
    `<p>Here's your ${data.days}-day Pro trial key. Paste it into ${escape(store.name)} to activate. No card, no auto-renewal.</p>
     <p style="margin:16px 0;padding:12px 16px;background:#f6f6f6;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;word-break:break-all">${escape(data.key)}</p>
     <p>When the ${data.days} days are up, the app stays free at its base tier.</p>
     <p><a href="${escape(data.pricingUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">See Pro</a></p>`);

// SUBSCRIBER-1: double opt-in confirmation. Topic-aware copy so the waitlist
// template can read "you're on the ScrapeRight waitlist" without inventing a
// second template class for every product name. Topic = '' = the general
// newsletter (fallback wording).
export const subscriberConfirm = (store: StoreCtx, data: {
  confirmUrl: string;
  unsubscribeUrl: string;
  topic: string;
  topicLabel?: string;
}) => {
  const label = data.topicLabel ?? (data.topic ? `the ${data.topic} waitlist` : 'the newsletter');
  return wrap(store, `Confirm your subscription`,
    `<p>Thanks for signing up for <strong>${escape(label)}</strong> from ${escape(store.name)}. Please confirm your email to finish subscribing:</p>
     <p><a href="${escape(data.confirmUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Confirm subscription</a></p>
     <p>Or paste this link into your browser:<br><span style="color:#666;font-size:12px;word-break:break-all">${escape(data.confirmUrl)}</span></p>
     <p>If you didn't sign up, you can safely ignore this email — no subscription will be created. Or <a href="${escape(data.unsubscribeUrl)}">unsubscribe</a>.</p>`);
};

// SUBSCRIBER-1: a separate template for the waitlist to make the marketing copy
// product-aware. Kept tiny on purpose — the existing subscriberConfirm is the
// canonical template; this only exists so the body copy can say "ScrapeRight"
// instead of "the scraperight waitlist" when we know the human-readable label.
export const waitlistConfirm = (store: StoreCtx, data: {
  confirmUrl: string;
  unsubscribeUrl: string;
  productName: string;
}) =>
  wrap(store, `Confirm your spot on the ${data.productName} waitlist`,
    `<p>Thanks for joining the <strong>${escape(data.productName)}</strong> waitlist at ${escape(store.name)}. We'll email you the moment it's ready.</p>
     <p><a href="${escape(data.confirmUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Confirm my spot</a></p>
     <p>Or paste this link into your browser:<br><span style="color:#666;font-size:12px;word-break:break-all">${escape(data.confirmUrl)}</span></p>
     <p>Changed your mind? <a href="${escape(data.unsubscribeUrl)}">Unsubscribe</a>.</p>`);

// REWARDS-1: points earned. `lines` itemizes this posting (e.g. order points +
// first-order bonus); `balance` is the spendable balance AFTER it. Copy states
// only facts from the ledger — no promises beyond the program's own rules.
export const pointsEarned = (store: StoreCtx, data: {
  points: number; balance: number; lines: Array<{ label: string; points: number }>; accountUrl?: string;
}) =>
  wrap(store, `You earned ${data.points.toLocaleString('en-US')} points`,
    `<p>Your points balance was updated.</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">${data.lines.map((l) => `<tr><td>${escape(l.label)}</td><td style="text-align:right">+${l.points.toLocaleString('en-US')}</td></tr>`).join('')}</table>
     <p><strong>New balance: ${data.balance.toLocaleString('en-US')} points</strong></p>
     ${data.accountUrl ? `<p>See your points at <a href="${escape(data.accountUrl)}">${escape(data.accountUrl)}</a></p>` : ''}`);

// REWARDS-1: review approved. `points` is 0 when no bonus applied (program
// off, guest review, or verified-buyer-only rule) — then no points copy.
export const reviewApproved = (store: StoreCtx, data: {
  productName: string; points: number; balance: number | null; productUrl?: string;
}) =>
  wrap(store, 'Your review is live',
    `<p>Thanks for reviewing <strong>${escape(data.productName)}</strong>. Your review has been approved and is now published.</p>
     ${data.points > 0 ? `<p>We added <strong>${data.points.toLocaleString('en-US')} points</strong> to your account${data.balance != null ? ` (balance: ${data.balance.toLocaleString('en-US')} points)` : ''}.</p>` : ''}
     ${data.productUrl ? `<p><a href="${escape(data.productUrl)}">View your review</a></p>` : ''}`);

// Order editing (G13): "your order was updated". `changes` is a pre-rendered,
// human list of what changed (the server builds it from the line diff). When a
// balance is owed the pay link is included; a credit is described as such.
const money2 = (cents: number, currency: string) => `${(Math.abs(cents) / 100).toFixed(2)} ${currency}`;
export const orderUpdated = (store: StoreCtx, data: {
  code: string; currency: string; beforeTotal: number; afterTotal: number;
  changes: string[]; balance: number; payUrl?: string; reason?: string | null;
}) =>
  wrap(store, `Your order ${data.code} was updated`,
    `<p>We made changes to your order <strong>${escape(data.code)}</strong>.</p>
     ${data.reason ? `<p>${escape(data.reason)}</p>` : ''}
     ${data.changes.length ? `<ul style="padding-left:18px">${data.changes.map((c) => `<li>${escape(c)}</li>`).join('')}</ul>` : ''}
     <p>Previous total: ${money2(data.beforeTotal, data.currency)}<br><strong>New total: ${money2(data.afterTotal, data.currency)}</strong></p>
     ${data.balance > 0
       ? `<p><strong>Amount due: ${money2(data.balance, data.currency)}</strong></p>${data.payUrl ? `<p><a href="${escape(data.payUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Pay the balance</a></p><p style="color:#666;font-size:12px;word-break:break-all">${escape(data.payUrl)}</p>` : ''}`
       : data.balance < 0 ? `<p>The difference of ${money2(data.balance, data.currency)} is being returned to you.</p>` : ''}
     <p>View your order at <a href="${escape(store.storefrontUrl)}/orders/${escape(data.code)}">${escape(store.storefrontUrl)}/orders/${escape(data.code)}</a></p>`);

// Order editing (G13): pay link for a balance, sent on its own when the
// customer is not also getting the "order updated" summary.
export const orderBalanceDue = (store: StoreCtx, data: { code: string; currency: string; amountDue: number; payUrl: string }) =>
  wrap(store, `Balance due on order ${data.code}`,
    `<p>There is a balance of <strong>${money2(data.amountDue, data.currency)}</strong> due on your order <strong>${escape(data.code)}</strong>.</p>
     <p><a href="${escape(data.payUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Pay the balance</a></p>
     <p style="color:#666;font-size:12px;word-break:break-all">${escape(data.payUrl)}</p>`);
