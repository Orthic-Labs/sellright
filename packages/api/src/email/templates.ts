/**
 * Email templates (WP2b). Plain TS functions — no template engine dep. Each
 * returns {subject, html, text} so the mailer stays dumb.
 */
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
const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

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

export const passwordReset = (store: StoreCtx, data: { url: string; ttlHours: number }) =>
  wrap(store, 'Reset your password',
    `<p>Someone (hopefully you) asked to reset your password. Click below within ${data.ttlHours} hours:</p>
     <p><a href="${escape(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Reset password</a></p>
     <p>If you didn't ask, ignore this email — your password stays the same.</p>`);

export const emailVerify = (store: StoreCtx, data: { url: string }) =>
  wrap(store, 'Verify your email',
    `<p>Welcome! Please confirm your email address:</p>
     <p><a href="${escape(data.url)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Verify email</a></p>`);

export const staffInvite = (store: StoreCtx, data: { acceptUrl: string; role: string; inviterEmail: string }) =>
  wrap(store, `${data.inviterEmail} invited you to ${store.name}`,
    `<p>You've been invited to help manage <strong>${escape(store.name)}</strong> as a <strong>${escape(data.role)}</strong>.</p>
     <p><a href="${escape(data.acceptUrl)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;text-decoration:none;border-radius:6px">Accept invite</a></p>`);

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
