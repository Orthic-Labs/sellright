import { component$, useStore, useVisibleTask$, $ } from '@qwik.dev/core';
import { type DocumentHead } from '@qwik.dev/router';
import { BRAND_LICENSE } from '~/platform/brand-data';
import { variantByKey } from '~/platform/host-variant';
import { login, register, logout as apiLogout, myLicenses, getUpgradeEligibility, requestMagicLink, requestPasswordReset, type License, type UpgradeOffer } from '../../api';
import { loadTurnstile, renderTurnstile, TURNSTILE_SITE_KEY } from '../../turnstile';

/** Without a configured site key there is no widget: the forms do not wait for a token (the API enforces Turnstile only when it has a secret). */
const TOKEN_REQUIRED = !!TURNSTILE_SITE_KEY;
import { fmtMoney } from '../../variant';
import { useHostVariant } from '../layout';

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—');
const UPGRADE = BRAND_LICENSE?.upgradeCredit;
const HAS_DEVICES = !!BRAND_LICENSE?.devices;

// One generic failure line for every path on this page. It never says whether
// an account exists for the email (no account-enumeration oracle).
const GENERIC_ERROR = 'We couldn’t complete that. Check your details and try again.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailOk = (e: string) => EMAIL_RE.test(e.trim());

const TS_CONTAINER = 'acct-turnstile';
const TS_HINT = 'Complete the verification above to continue.';
const TS_ERROR = 'Verification couldn’t load. Refresh the page or try another browser.';

type TsState = { turnstileToken: string; turnstileWidgetId: string; turnstileError: boolean };

/** (Re)render the single Turnstile widget into the current view's container.
 *  Tokens are single-use, so this runs on every mount and after every submit.
 *  `waitForDom` is set only from the view-change task, where Qwik may not have
 *  painted the new container yet. */
async function mountWidget(st: TsState, waitForDom: boolean) {
  if (!TOKEN_REQUIRED) return;
  const find = () => document.getElementById(TS_CONTAINER);
  let el = find();
  for (let i = 0; waitForDom && !el && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    el = find();
  }
  if (!el) return;
  st.turnstileToken = '';
  st.turnstileError = false;
  try {
    await loadTurnstile();
  } catch {
    st.turnstileError = true;
    return;
  }
  if (!find()) return;
  const prev = st.turnstileWidgetId;
  st.turnstileWidgetId = renderTurnstile(
    TS_CONTAINER,
    (token) => { st.turnstileToken = token; if (token) st.turnstileError = false; },
    () => { st.turnstileError = true; },
    prev,
  );
}

export default component$(() => {
  const store = useHostVariant();
  const st = useStore({
    // One combined sign-in screen (owner-approved): email + password, with the
    // reset and email-link options beneath it. 'register' and 'forgot' are the
    // only other views.
    mode: 'signin' as 'signin' | 'register' | 'forgot',
    email: '',
    password: '',
    // the session itself lives only in the httpOnly `sr_cust` cookie
    // the API sets (auth/cookies.ts) — never in a client-readable store or
    // localStorage. `loggedIn` is just a UI flag derived from whether the
    // cookie-authenticated /account/licenses call succeeded.
    loggedIn: false,
    licenses: [] as License[],
    mobileUpgrade: null as UpgradeOffer | null,
    mobileUpgradeChecked: false,
    loaded: false,
    error: '',
    busy: false,
    linkSent: false,
    resetSent: false,
    // Cloudflare Turnstile: the widget token gates every auth action button.
    turnstileToken: '',
    turnstileWidgetId: '',
    turnstileError: false,
  });

  const loadLicenses = $(async () => {
    try {
      const res = await myLicenses();
      st.licenses = res.items;
      st.loggedIn = true;
      if (UPGRADE && store.value.key === UPGRADE.appKey) {
        try {
          const offer = await getUpgradeEligibility();
          st.mobileUpgrade = offer.eligible ? offer : null;
        } catch {
          // Eligibility is optional; keep license access working if endpoint is unavailable.
          st.mobileUpgrade = null;
        } finally {
          st.mobileUpgradeChecked = true;
        }
      }
    } catch {
      // No/expired session cookie — show the sign-in form.
      st.loggedIn = false;
    } finally {
      st.loaded = true;
    }
  });

  useVisibleTask$(async () => {
    await loadLicenses();
  });

  // Mount the widget whenever a form view with a container is shown.
  useVisibleTask$(({ track }) => {
    track(() => st.loaded);
    track(() => st.loggedIn);
    track(() => st.mode);
    track(() => st.linkSent);
    track(() => st.resetSent);
    const formShown = st.loaded && !st.loggedIn && !st.linkSent && !(st.mode === 'forgot' && st.resetSent);
    if (formShown) void mountWidget(st, true);
  });

  const signIn = $(async () => {
    const email = st.email.trim();
    const token = st.turnstileToken;
    if (st.busy || !emailOk(email) || st.password.length === 0 || (TOKEN_REQUIRED && !token && !st.turnstileError)) return;
    st.error = '';
    st.busy = true;
    try {
      // The API sets the sr_cust session cookie on this same response
      // (Set-Cookie) — the JSON body's `token` field is for bearer clients
      // and is never read here.
      await login(email, st.password, token);
      await loadLicenses();
    } catch {
      st.error = GENERIC_ERROR;
    } finally {
      st.busy = false;
      void mountWidget(st, false);
    }
  });

  const createAccount = $(async () => {
    const email = st.email.trim();
    const token = st.turnstileToken;
    if (st.busy || !emailOk(email) || st.password.length < 8 || (TOKEN_REQUIRED && !token && !st.turnstileError)) return;
    st.error = '';
    st.busy = true;
    try {
      await register(email, st.password, token);
      await loadLicenses();
    } catch {
      st.error = GENERIC_ERROR;
    } finally {
      st.busy = false;
      void mountWidget(st, false);
    }
  });

  const sendReset = $(async () => {
    const email = st.email.trim();
    const token = st.turnstileToken;
    if (st.busy || !emailOk(email) || (TOKEN_REQUIRED && !token && !st.turnstileError)) return;
    st.error = '';
    st.busy = true;
    try {
      // Always resolves { ok: true } — the same confirmation shows whether or
      // not an account exists for this email.
      await requestPasswordReset(email, token);
      st.resetSent = true;
    } catch {
      st.error = GENERIC_ERROR;
    } finally {
      st.busy = false;
      void mountWidget(st, false);
    }
  });

  const sendMagicLink = $(async () => {
    const email = st.email.trim();
    const token = st.turnstileToken;
    if (st.busy || !emailOk(email) || (TOKEN_REQUIRED && !token && !st.turnstileError)) return;
    st.error = '';
    st.busy = true;
    try {
      // Always resolves to { ok: true } — the API never reveals whether the
      // email is registered, so the UI shows the same "check your email"
      // state either way (no account-enumeration oracle).
      await requestMagicLink(email, token);
      st.linkSent = true;
    } catch {
      st.error = GENERIC_ERROR;
    } finally {
      st.busy = false;
      void mountWidget(st, false);
    }
  });

  const logout = $(async () => {
    // The session is an httpOnly cookie only the API can clear: the page shows signed-out only once it has.
    st.error = '';
    try { await apiLogout(); } catch {
      st.error = 'Sign-out did not complete. Check your connection and try again.';
      return;
    }
    st.loggedIn = false;
    st.licenses = [];
    st.mobileUpgrade = null;
    st.mobileUpgradeChecked = false;
  });

  if (!st.loaded) {
    return <main class="wrap section"><p class="muted">Loading…</p></main>;
  }

  if (!st.loggedIn) {
    // Grey-until-ready: every primary button is disabled (and greyed by the
    // .acct-auth rule in global.css) until its own inputs are valid AND the
    // Turnstile token is present. If the widget cannot load at all (blocked script,
    // CSP, network), the buttons fall back to field validation only and the API
    // stays the authority: it rejects a missing token wherever Turnstile is enforced,
    // which beats a button that can never become ready.
    const emailReady = emailOk(st.email);
    const human = !TOKEN_REQUIRED || st.turnstileToken !== '' || st.turnstileError;
    const signInReady = emailReady && st.password.length > 0 && human;
    const registerReady = emailReady && st.password.length >= 8 && human;
    const resetReady = emailReady && human;
    const magicReady = emailReady && human;

    if (st.linkSent) {
      return (
        <main class="wrap section acct-auth">
          <h1>Check your email</h1>
          <p class="lead">
            If <strong>{st.email.trim()}</strong> has a {store.value.name} account, a sign-in link just went out. It
            expires in 15 minutes and works once.
          </p>
          <div class="card" style="max-width:420px;margin-top:24px">
            <p class="note" style="margin-top:0">Didn't get it? Check spam, or</p>
            <button class="btn ghost block" onClick$={() => { st.linkSent = false; st.error = ''; }}>
              Back to sign in
            </button>
          </div>
        </main>
      );
    }

    if (st.mode === 'forgot') {
      return (
        <main class="wrap section acct-auth">
          <h1>Reset your password</h1>
          <p class="lead">Enter the email on your {store.value.name} account and we'll send a reset link.</p>
          <div class="card" style="max-width:420px;margin-top:24px">
            {st.resetSent ? (
              <>
                <p class="note" style="margin-top:0">
                  If <strong>{st.email.trim()}</strong> has an account, a reset link is on its way. The link works once.
                </p>
                <p class="note"><a href="#" preventdefault:click onClick$={() => { st.mode = 'signin'; st.resetSent = false; st.error = ''; }}>← Back to sign in</a></p>
              </>
            ) : (
              <form preventdefault:submit onSubmit$={sendReset}>
                <div class="field"><label for="acct-reset-email">Email</label>
                  <input id="acct-reset-email" name="email" type="email" autocomplete="email" required
                    value={st.email} onInput$={(e) => (st.email = (e.target as HTMLInputElement).value)} /></div>
                <div id={TS_CONTAINER} style="display:flex;justify-content:center;min-height:65px;margin:12px 0"></div>
                {st.turnstileError && <p class="err" role="alert">{TS_ERROR}</p>}
                {emailReady && !human && !st.turnstileError && <p class="note">{TS_HINT}</p>}
                <button type="submit" class="btn block" disabled={!resetReady || st.busy} aria-disabled={!resetReady || st.busy ? 'true' : 'false'}>
                  {st.busy ? 'Sending…' : 'Send reset link'}
                </button>
                {st.error && <p class="err" role="alert">{st.error}</p>}
                <p class="note"><a href="#" preventdefault:click onClick$={() => { st.mode = 'signin'; st.error = ''; }}>← Back to sign in</a></p>
              </form>
            )}
          </div>
        </main>
      );
    }

    if (st.mode === 'register') {
      return (
        <main class="wrap section acct-auth">
          <h1>Create account</h1>
          <p class="lead">View and manage your {store.value.name} licenses and devices.</p>
          <div class="card" style="max-width:420px;margin-top:24px">
            <form preventdefault:submit onSubmit$={createAccount}>
              <div class="field"><label for="acct-reg-email">Email</label>
                <input id="acct-reg-email" name="email" type="email" autocomplete="email" required
                  value={st.email} onInput$={(e) => (st.email = (e.target as HTMLInputElement).value)} /></div>
              <div class="field"><label for="acct-reg-password">Password (8+ characters)</label>
                <input id="acct-reg-password" name="password" type="password" autocomplete="new-password" minLength={8} required
                  value={st.password} onInput$={(e) => (st.password = (e.target as HTMLInputElement).value)} /></div>
              <div id={TS_CONTAINER} style="display:flex;justify-content:center;min-height:65px;margin:12px 0"></div>
              {st.turnstileError && <p class="err" role="alert">{TS_ERROR}</p>}
              {emailReady && st.password.length >= 8 && !human && !st.turnstileError && <p class="note">{TS_HINT}</p>}
              <button type="submit" class="btn block" disabled={!registerReady || st.busy} aria-disabled={!registerReady || st.busy ? 'true' : 'false'}>
                {st.busy ? 'Creating…' : 'Create account'}
              </button>
              {st.error && <p class="err" role="alert">{st.error}</p>}
            </form>
            <p class="note">
              Already have an account?{' '}
              <a href="#" preventdefault:click onClick$={() => { st.mode = 'signin'; st.error = ''; }}>Sign in</a>
            </p>
          </div>
        </main>
      );
    }

    // Default: the combined sign-in screen.
    return (
      <main class="wrap section acct-auth">
        <h1>Sign in</h1>
        <p class="lead">View and manage your {store.value.name} licenses and devices.</p>
        <div class="card" style="max-width:420px;margin-top:24px">
          <form preventdefault:submit onSubmit$={signIn}>
            <div class="field"><label for="acct-email">Email</label>
              <input id="acct-email" name="email" type="email" autocomplete="email" required
                value={st.email} onInput$={(e) => (st.email = (e.target as HTMLInputElement).value)} /></div>
            <div class="field"><label for="acct-password">Password</label>
              <input id="acct-password" name="password" type="password" autocomplete="current-password" required
                value={st.password} onInput$={(e) => (st.password = (e.target as HTMLInputElement).value)} /></div>
            <div id={TS_CONTAINER} style="display:flex;justify-content:center;min-height:65px;margin:12px 0"></div>
            {st.turnstileError && <p class="err" role="alert">{TS_ERROR}</p>}
            {emailReady && !human && !st.turnstileError && <p class="note">{TS_HINT}</p>}
            <button type="submit" class="btn block" disabled={!signInReady || st.busy} aria-disabled={!signInReady || st.busy ? 'true' : 'false'}>
              {st.busy ? 'Signing in…' : 'Sign in'}
            </button>
            {st.error && <p class="err" role="alert">{st.error}</p>}
          </form>
          <p class="note">
            <a href="#" preventdefault:click onClick$={() => { st.mode = 'forgot'; st.resetSent = false; st.error = ''; }}>Forgot your password? Reset it</a>
          </p>
          <div style="margin-top:18px">
            <button type="button" class="btn ghost block" disabled={!magicReady || st.busy} aria-disabled={!magicReady || st.busy ? 'true' : 'false'} onClick$={sendMagicLink}>
              {st.busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </div>
          <p class="note">
            New here?{' '}
            <a href="#" preventdefault:click onClick$={() => { st.mode = 'register'; st.error = ''; }}>Create an account</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main class="wrap section">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h1>My account</h1>
        <button class="btn ghost" onClick$={logout}>Sign out</button>
      </div>
      {st.error && <p class="err" role="alert">{st.error}</p>}
      <div class="note" style="margin-top:12px">
        {HAS_DEVICES && <><a href="/account/devices/">Manage devices</a> · </>}<a href="/account/delete/">Delete account</a>
      </div>
      <h2 style="margin-top:32px">Licenses</h2>
      {UPGRADE && store.value.key === UPGRADE.appKey && st.mobileUpgradeChecked && st.mobileUpgrade && (
        <div class="card hr-upgrade-card" style="margin-top:18px;max-width:720px">
          <div class="hr-upgrade-kicker">{UPGRADE.sourceName} credit</div>
          <h2 style="margin-top:5px">Move to {UPGRADE.targetName}</h2>
          <p class="note" style="margin-top:7px">
            Your verified {UPGRADE.sourceName} purchase includes a {fmtMoney(st.mobileUpgrade.credit)} credit toward {UPGRADE.targetName}.
          </p>
          <div class="summary hr-upgrade-summary" style="margin-top:15px;padding:14px">
            <div class="line"><span class="muted">{UPGRADE.targetName}</span><span>{fmtMoney(st.mobileUpgrade.fullPrice)}</span></div>
            <div class="line"><span class="muted">{UPGRADE.sourceName} credit</span><span>−{fmtMoney(st.mobileUpgrade.credit)}</span></div>
            <div class="line total"><span>Upgrade today</span><span>{fmtMoney(st.mobileUpgrade.upgradePrice)}</span></div>
          </div>
          <a class="btn" style="margin-top:16px" href={`/checkout/?sku=${encodeURIComponent(UPGRADE.sku)}&upgrade=mobile`}>
            {st.mobileUpgrade.pendingOrder ? 'Continue upgrade' : `Upgrade to ${UPGRADE.targetName}`}
          </a>
          {st.mobileUpgrade.pendingOrder && <p class="note">A pending upgrade order is ready to continue.</p>}
        </div>
      )}
      {st.licenses.length === 0 && <p class="lead" style="margin-top:16px">No licenses yet.</p>}
      <div class="grid" style="margin-top:24px">
        {st.licenses.map((l) => {
          const brand = variantByKey(l.appKey);
          return (
            <div class="card" key={l.licenseKey}>
              <h2>{brand?.name ?? l.appKey}</h2>
              <p class="note" style="margin-top:0">Status: {l.status} · {l.seats} seat{l.seats > 1 ? 's' : ''}</p>
              <div class="keybox" style="margin-top:12px">{l.licenseKey}</div>
              <div class="summary" style="margin-top:14px;padding:14px">
                <div class="line"><span class="muted">Updates until</span><span>{l.expiresAt ? fmtDate(l.expiresAt) : (l.updatesUntil ? fmtDate(l.updatesUntil) : 'Lifetime')}</span></div>
                <div class="line"><span class="muted">Latest version</span><span>{l.latestVersion ?? '—'}</span></div>
              </div>
              {l.download?.url
                ? <a class="btn block" style="margin-top:14px" href={l.download.url}>Download {l.download.version}</a>
                : <p class="note">Download links appear here once a release is published.</p>}
            </div>
          );
        })}
      </div>
    </main>
  );
});

export const head: DocumentHead = ({ resolveValue }) => {
  const store = resolveValue(useHostVariant);
  return { title: `My account — ${store.name}` };
};
