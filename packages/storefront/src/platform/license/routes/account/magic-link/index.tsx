import { component$, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { type DocumentHead, useLocation } from '@qwik.dev/router';
import { consumeMagicLink } from '../../../api';
import { useHostVariant } from '../../layout';

// Landing route for the magic-link email. Its path and
// query param are NOT arbitrary — packages/api/src/routes/auth.ts builds the
// emailed URL as exactly `${STOREFRONT_URL}/account/magic-link?token=<raw>`,
// so this route must live at /account/magic-link.
export default component$(() => {
  const store = useHostVariant();
  const loc = useLocation();
  const st = useStore<{ status: 'consuming' | 'ok' | 'error'; error: string }>({
    status: 'consuming',
    error: '',
  });

  useVisibleTask$(async () => {
    const token = loc.url.searchParams.get('token');
    if (!token) {
      st.status = 'error';
      st.error = 'This link is missing its token.';
      return;
    }
    try {
      // the API sets the sr_cust httpOnly session cookie on this same
      // response (Set-Cookie) — the JSON body's `token` is for bearer
      // clients and is never read or stored here.
      await consumeMagicLink(token);
      st.status = 'ok';
      // Land on the account home already signed in (cookie already set).
      window.location.replace('/account/');
    } catch (e) {
      st.status = 'error';
      const status = (e as Error & { status?: number }).status;
      st.error = status === 409
        ? 'This link is invalid, expired, or has already been used. Request a new one below.'
        : (e as Error).message || 'Could not sign you in.';
    }
  });

  return (
    <main class="wrap section">
      <h1>Signing you in…</h1>
      {st.status === 'consuming' && <p class="lead">One moment.</p>}
      {st.status === 'error' && (
        <div class="card" style="max-width:420px;margin-top:24px">
          <p class="err" style="margin-top:0">{st.error}</p>
          <a class="btn block" style="margin-top:14px" href="/account/">Back to sign in</a>
        </div>
      )}
      {st.status === 'ok' && <p class="lead">Success — redirecting to your {store.value.name} account…</p>}
    </main>
  );
});

export const head: DocumentHead = ({ resolveValue }) => {
  const store = resolveValue(useHostVariant);
  return { title: `Signing in — ${store.name}`, meta: [{ name: 'robots', content: 'noindex, nofollow' }] };
};
