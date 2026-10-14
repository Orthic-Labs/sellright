import { component$, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { useLocation, Link, type DocumentHead } from '@qwik.dev/router';
import { getOrder, type ApiError } from '../../../../api';
import { confirmationLegalLinks, sellerLine, supportEmailFor } from '../../../../legal';
import { useHostVariant } from '../../../layout';

type View = 'checking' | 'paid' | 'pending' | 'failed' | 'unknown';

/** Paid or later (a refund keeps the license history): the order really is confirmed. */
const PAID = new Set(['paid', 'partially_refunded', 'refunded']);
const POLLS = 10;
const POLL_MS = 2000;

// The order's real state, read from the API with the receipt token (`?rt=`, set by checkout) or the owner's session. Nothing is
// claimed before that read: a Stripe redirect can land here before the webhook settles, so a pending order is re-read a few times.
export default component$(() => {
  const loc = useLocation();
  const store = useHostVariant();
  const code = loc.params.code;
  const st = useStore<{ view: View }>({ view: 'checking' });
  const supportEmail = supportEmailFor(store.value.domain);
  const legal = confirmationLegalLinks(store.value.key);

  useVisibleTask$(async ({ cleanup }) => {
    let stopped = false;
    cleanup(() => { stopped = true; });
    const rt = new URLSearchParams(window.location.search).get('rt') ?? undefined;
    for (let i = 0; i < POLLS && !stopped; i++) {
      try {
        const order = await getOrder(code, rt);
        if (PAID.has(order.paymentStatus)) { st.view = 'paid'; return; }
        if (order.paymentStatus === 'failed' || order.paymentStatus === 'voided') { st.view = 'failed'; return; }
        st.view = 'pending';
      } catch (e) {
        st.view = (e as ApiError).status === 404 || (e as ApiError).status === 401 ? 'unknown' : 'pending';
        if (st.view === 'unknown') return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });

  return (
    <div>
      <main class="wrap section">
        {st.view === 'paid' ? (
          <>
            <h1>Thank you — order confirmed</h1>
            <p class="lead">Your {store.value.name} order <strong>{code}</strong> is complete.</p>
            <div class="card" style="max-width:520px;margin-top:24px">
              <p class="ok">Your license key has been emailed to you.</p>
              <p class="note">
                Sign in to view and manage your license keys, seats, and downloads any time.
              </p>
              <p class="note" style="margin-top:12px">
                Need help with delivery or refunds? Contact <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
              </p>
              <Link class="btn" style="margin-top:14px" href="/account">View my licenses →</Link>
            </div>
          </>
        ) : (
          <>
            <h1>Order {code}</h1>
            <p class="lead">
              {st.view === 'checking' && <>Checking your {store.value.name} order…</>}
              {st.view === 'pending' && <>Your payment is being confirmed. This page updates on its own; do not pay again.</>}
              {st.view === 'failed' && <>The payment for this order did not complete. You have not been charged for it.</>}
              {st.view === 'unknown' && <>This order can't be shown here. Sign in to see your orders and licenses.</>}
            </p>
            <div class="card" style="max-width:520px;margin-top:24px">
              <p class="note" style="margin-top:0">
                Questions about order <strong>{code}</strong>? Contact <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
              </p>
              <Link class="btn" style="margin-top:14px" href="/account">My account →</Link>
            </div>
          </>
        )}
      </main>
      <div class="wrap" style="display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:0 24px 28px;color:#6E665F;font-size:12px">
        <div>{sellerLine()} · <a href={`mailto:${supportEmail}`}>{supportEmail}</a></div>
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          <a href={legal.privacy}>Privacy</a>
          <a href={legal.terms}>Terms</a>
          <a href={legal.refund}>Refunds</a>
          <a href={legal.contact}>Contact</a>
        </div>
      </div>
    </div>
  );
});

export const head: DocumentHead = ({ resolveValue, params }) => {
  const store = resolveValue(useHostVariant);
  return { title: `Order ${params.code} — ${store.name}`, meta: [{ name: 'robots', content: 'noindex, nofollow' }] };
};
