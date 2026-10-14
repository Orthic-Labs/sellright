import { component$, useStore, $ } from '@qwik.dev/core';
import { type DocumentHead, useLocation } from '@qwik.dev/router';
import { resetPassword } from '../../api';
import { useHostVariant } from '../layout';

// Landing route for the password-reset email. packages/api/src/routes/customer-tokens.ts
// builds the emailed URL as exactly `${storefront}/password-reset?token=<raw>`,
// so this route must live at /password-reset.
const GENERIC_ERROR = 'That reset link is invalid, expired, or already used. Request a new one from the sign-in page.';

export default component$(() => {
  const store = useHostVariant();
  const loc = useLocation();
  const token = loc.url.searchParams.get('token') ?? '';
  const st = useStore({ password: '', busy: false, done: false, error: '' });

  const save = $(async () => {
    if (st.busy || !token || st.password.length < 8) return;
    st.error = '';
    st.busy = true;
    try {
      await resetPassword(token, st.password);
      st.done = true;
    } catch {
      st.error = GENERIC_ERROR;
    } finally {
      st.busy = false;
    }
  });

  const ready = token.length > 0 && st.password.length >= 8;

  return (
    <main class="wrap section acct-auth">
      <h1>Choose a new password</h1>
      {!token && (
        <div class="card" style="max-width:420px;margin-top:24px">
          <p class="err" style="margin-top:0">{GENERIC_ERROR}</p>
          <a class="btn block" style="margin-top:14px" href="/account/">Back to sign in</a>
        </div>
      )}
      {token && !st.done && (
        <div class="card" style="max-width:420px;margin-top:24px">
          <p class="lead" style="margin-top:0">Set a new password for your {store.value.name} account (8+ characters).</p>
          <form preventdefault:submit onSubmit$={save}>
            <div class="field"><label for="reset-password">New password</label>
              <input id="reset-password" name="password" type="password" autocomplete="new-password" minLength={8} required
                value={st.password} onInput$={(e) => (st.password = (e.target as HTMLInputElement).value)} /></div>
            <button type="submit" class="btn block" disabled={!ready || st.busy} aria-disabled={!ready || st.busy ? 'true' : 'false'}>
              {st.busy ? 'Saving…' : 'Save new password'}
            </button>
            {st.error && <p class="err" role="alert">{st.error}</p>}
          </form>
        </div>
      )}
      {st.done && (
        <div class="card" style="max-width:420px;margin-top:24px">
          <p class="lead" style="margin-top:0">Your password is updated. Sign in with it to continue.</p>
          <a class="btn block" style="margin-top:14px" href="/account/">Sign in</a>
        </div>
      )}
    </main>
  );
});

export const head: DocumentHead = ({ resolveValue }) => {
  const store = resolveValue(useHostVariant);
  return { title: `Reset password — ${store.name}`, meta: [{ name: 'robots', content: 'noindex, nofollow' }] };
};
