import { component$, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { type DocumentHead } from '@qwik.dev/router';
import { verifyEmail } from '../../api';
import { useHostVariant } from '../layout';

// Landing route of the registration email: the API builds the link as exactly `${storefront}/verify?token=<raw>`.
export default component$(() => {
  const store = useHostVariant();
  const st = useStore<{ status: 'verifying' | 'ok' | 'error'; error: string }>({ status: 'verifying', error: '' });

  useVisibleTask$(async () => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      st.status = 'error';
      st.error = 'This link is missing its token.';
      return;
    }
    try {
      await verifyEmail(token);
      st.status = 'ok';
    } catch (e) {
      st.status = 'error';
      st.error = (e as Error & { status?: number }).status === 409
        ? 'This link is invalid, expired, or has already been used.'
        : 'We couldn’t verify your email. Try the link again.';
    }
  });

  return (
    <main class="wrap section">
      <h1>Verify your email</h1>
      {st.status === 'verifying' && <p class="lead">One moment.</p>}
      {st.status === 'ok' && (
        <div class="card" style="max-width:420px;margin-top:24px">
          <p class="ok" style="margin-top:0">Your email is verified. Sign in to see your {store.value.name} licenses.</p>
          <a class="btn block" style="margin-top:14px" href="/account/">Sign in</a>
        </div>
      )}
      {st.status === 'error' && (
        <div class="card" style="max-width:420px;margin-top:24px">
          <p class="err" style="margin-top:0">{st.error}</p>
          <a class="btn block" style="margin-top:14px" href="/account/">Back to sign in</a>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = ({ resolveValue }) => {
  const store = resolveValue(useHostVariant);
  return { title: `Verify email — ${store.name}`, meta: [{ name: 'robots', content: 'noindex, nofollow' }] };
};
