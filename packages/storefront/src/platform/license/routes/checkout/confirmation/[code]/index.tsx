import { component$ } from '@qwik.dev/core';
import { useLocation, Link, type DocumentHead } from '@qwik.dev/router';
import { confirmationLegalLinks, sellerLine, supportEmailFor } from '../../../../legal';
import { useHostVariant } from '../../../layout';

export default component$(() => {
  const loc = useLocation();
  const store = useHostVariant();
  const code = loc.params.code;
  const supportEmail = supportEmailFor(store.value.domain);
  const legal = confirmationLegalLinks(store.value.key);
  return (
    <div>
      <main class="wrap section">
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
  return { title: `Order ${params.code} confirmed — ${store.name}` };
};
