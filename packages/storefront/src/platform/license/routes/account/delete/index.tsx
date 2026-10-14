import { component$, useStore, useVisibleTask$, $ } from '@qwik.dev/core';
import { type DocumentHead } from '@qwik.dev/router';
import { deleteAccount, me } from '../../../api';
import { useHostVariant } from '../../layout';

// Account deletion entry point on the site. Wired against the
// real endpoint — packages/api/src/routes/account.ts `DELETE /v1/shop/account`
// — which hard-deletes the customer + PII-bearing rows and ANONYMIZES (not
// deletes) order rows, since those are financial/legal records. It 409s if
// there's an active subscription; that must be cancelled first.
export default component$(() => {
  const store = useHostVariant();
  const st = useStore({
    // no client-held bearer — the sr_cust httpOnly cookie carries the
    // session; `loggedIn` only reflects the cookie-authenticated /auth/me check.
    loggedIn: false,
    loaded: false,
    confirming: false,
    confirmText: '',
    busy: false,
    error: '',
    done: false,
  });

  useVisibleTask$(async () => {
    try {
      await me();
      st.loggedIn = true;
    } catch {
      st.loggedIn = false;
    } finally {
      st.loaded = true;
    }
  });

  const submitDelete = $(async () => {
    st.error = '';
    st.busy = true;
    try {
      const res = await deleteAccount();
      if (!res.deleted) {
        st.error = 'Deletion did not complete. Nothing was changed — please try again or contact support.';
        return;
      }
      st.done = true;
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      st.error = status === 409
        ? 'You have an active subscription. Cancel it first, then delete your account.'
        : status === 401
        ? 'Your session has expired. Sign in again to delete your account.'
        : (e as Error).message || 'Deletion failed. Nothing was changed.';
    } finally {
      st.busy = false;
    }
  });

  if (!st.loaded) {
    return <main class="wrap section"><p class="muted">Loading…</p></main>;
  }

  if (!st.loggedIn) {
    return (
      <main class="wrap section">
        <h1>Delete account</h1>
        <p class="lead">You need to sign in to delete your account.</p>
        <a class="btn" style="margin-top:16px" href="/account/">Sign in →</a>
      </main>
    );
  }

  if (st.done) {
    return (
      <main class="wrap section">
        <h1>Account deleted</h1>
        <p class="lead">Your {store.value.name} account and profile data have been deleted.</p>
        <a class="btn" style="margin-top:16px" href="/">Back to {store.value.domain}</a>
      </main>
    );
  }

  return (
    <main class="wrap section">
      <h1>Delete account</h1>
      <p class="lead">Permanently delete your {store.value.name} account.</p>

      <div class="card" style="max-width:520px;margin-top:24px">
        <h2 style="margin-top:0">What gets deleted</h2>
        <ul>
          <li>Your account profile (email, name, phone)</li>
          <li>Saved addresses</li>
          <li>Device activations tied to your account (Pro is revoked on every device)</li>
        </ul>
        <h2 style="margin-top:18px">What is kept</h2>
        <ul>
          <li>Order records — required for accounting, tax, and refund history — are anonymized, not deleted</li>
          <li>Purchase/legal records required to satisfy retention obligations</li>
        </ul>
        <p class="note" style="margin-top:14px">
          Licenses tied to your account are detached (not deleted); if you sign back in with the same email you
          will not automatically regain access.
        </p>

        {st.error && <p class="err">{st.error}</p>}

        {!st.confirming ? (
          <button class="btn block" style="margin-top:16px" onClick$={() => (st.confirming = true)}>
            Delete my account
          </button>
        ) : (
          <div style="margin-top:16px">
            <label class="note" style="display:block;margin-bottom:6px">Type DELETE to confirm</label>
            <input
              type="text"
              value={st.confirmText}
              onInput$={(e) => (st.confirmText = (e.target as HTMLInputElement).value)}
              style="width:100%;padding:11px 13px;border:1px solid var(--border);border-radius:8px;font:inherit"
            />
            <div style="display:flex;gap:8px;margin-top:10px">
              <button
                class="btn"
                disabled={st.busy || st.confirmText !== 'DELETE'}
                onClick$={submitDelete}
              >
                {st.busy ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button class="btn ghost" onClick$={() => { st.confirming = false; st.confirmText = ''; }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
});

export const head: DocumentHead = ({ resolveValue }) => {
  const store = resolveValue(useHostVariant);
  return { title: `Delete account — ${store.name}`, meta: [{ name: 'robots', content: 'noindex, nofollow' }] };
};
