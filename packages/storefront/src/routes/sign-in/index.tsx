import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { routeLoader$, useNavigate } from '@qwik.dev/router';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { registerCustomerFromSignup } from '~/components/auth/signup-flow';
import { login, passwordResetFailureMessage, requestMagicLink, requestPasswordReset, resendVerification } from '~/providers/shop/account/account';
import { loginWithGoogle, renderGoogleButton } from '~/providers/shop/account/google-auth';
import { loginWithApple, preloadAppleSdk, signInWithApple } from '~/providers/shop/account/apple-auth';
import { loginWithPasskey } from '~/providers/shop/account/passkeys';
import { signInDestination } from '~/utils/sign-in-next';
import { getShopConfig } from '~/providers/shop/checkout/checkout';
import { socialSignInIdsForHost } from '~/utils/social-sign-in.server';
import { validatedRequestHost } from '~/utils/trusted-request.server';
import { SignInError } from './SignInError';
export { head } from './seo';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
/** Empty = Google sign-in off for THIS request's host: no button, no Google script, no Google origins in the CSP (the
 *  CSP in entry.express.tsx makes the same per-host decision from the same function). */
export const useGoogleClientId = routeLoader$(async ({ request }) =>
	(await socialSignInIdsForHost(
		validatedRequestHost({ host: request.headers.get('host') ?? undefined, 'x-forwarded-host': request.headers.get('x-forwarded-host') ?? undefined }),
	)).google,
	// Serialized into the page: read after load, the default ('never') re-fetched it and re-ran the route's loaders (#362).
	{ serializationStrategy: 'always' },
);

/** Empty = Apple sign-in off for THIS request's host (same per-host decision the CSP makes in entry.express.tsx). */
export const useAppleClientId = routeLoader$(async ({ request }) =>
	(await socialSignInIdsForHost(
		validatedRequestHost({ host: request.headers.get('host') ?? undefined, 'x-forwarded-host': request.headers.get('x-forwarded-host') ?? undefined }),
	)).apple,
	// Serialized into the page: read after load, the default ('never') re-fetched it and re-ran the route's loaders (#362).
	{ serializationStrategy: 'always' },
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAD_CREDENTIALS_HINT = "That email and password don't match.";
const TOKEN_MISSING_HINT = 'Complete the verification above to continue.';
const TOKEN_FAILED_HINT = "Verification couldn't load. Refresh the page or try another browser.";

type View = 'signin' | 'signup' | 'success' | 'reset-sent' | 'magic-sent' | 'verify-needed';

const PRIMARY =
	'w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer btn-ready';
const INPUT =
	'mt-1 appearance-none block w-full px-3 py-2.5 border border-[var(--color-card-border)] rounded-md shadow-xs placeholder-[var(--color-ink-muted)] focus:outline-hidden focus:ring-2 focus:ring-[var(--color-accent)] focus:border-[var(--color-ink-soft)] sm:text-sm bg-white';

const PROVIDER_BUTTON =
	'w-full flex justify-center py-3 px-4 border border-[var(--color-card-border)] rounded-md shadow-sm text-sm font-medium text-[var(--color-ink)] bg-white hover:bg-[var(--color-parchment)] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-60';
const APPLE_BUTTON =
	'w-full flex justify-center py-3 px-4 border border-black rounded-md shadow-sm text-sm font-medium text-white bg-black hover:bg-[var(--color-ink)] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-60';

export default component$(() => {
	const navigate = useNavigate();
	const googleClientId = useGoogleClientId();
	const appleClientId = useAppleClientId();

	const view = useSignal<View>('signin');
	const email = useSignal('');
	const password = useSignal('');
	const confirmPassword = useSignal('');
	const firstName = useSignal('');
	const lastName = useSignal('');
	const rememberMe = useSignal(true);
	const error = useSignal('');
	const loading = useSignal(false);
	const turnstileToken = useSignal('');
	const widgetError = useSignal(false);
	const widgetId = useSignal<string>();
	/** Set when the shopper lands here from a completed password reset (/password-reset redirects with ?reset=success). */
	const passwordResetDone = useSignal(false);
	useVisibleTask$(() => {
		passwordResetDone.value = new URLSearchParams(globalThis.location?.search ?? '').get('reset') === 'success';
	});
	const resendLoading = useSignal(false);
	const resendSent = useSignal(false);
	/** Whether this store has passwordless sign-in links switched on (GET /v1/shop/config) — offered only when it has. */
	const magicLinkEnabled = useSignal(false);

	/** Passkeys: the store has them on (GET /v1/shop/config auth.passkeys) AND this browser can use them. Both must hold. */
	const passkeysEnabled = useSignal(false);
	const passkeySupported = useSignal(false);
	const resetChallenge = $(() => {
		turnstileToken.value = '';
		if (widgetId.value) (window as any).turnstile?.reset(widgetId.value);
	});

	useVisibleTask$(async () => {
		try {
			const auth = (await getShopConfig()).auth as { magicLink?: boolean; passkeys?: boolean } | undefined;
			magicLinkEnabled.value = !!auth?.magicLink;
			passkeysEnabled.value = auth?.passkeys === true && browserSupportsWebAuthn();
		} catch {
			magicLinkEnabled.value = false; // fail closed: no link option rather than one that errors
			passkeysEnabled.value = false;
		}
		passkeySupported.value = passkeysEnabled.value;
	});

	/** Google's library failed to load or timed out: say so and offer a retry rather than leave a blank area. */
	const googleUnavailable = useSignal(false);
	const googleAttempt = useSignal(0);

	const handleGoogleCredential = $(async (credential: string) => {
		if (loading.value) return;
		error.value = '';
		loading.value = true;
		const result = await loginWithGoogle(credential);
		if (result.ok) {
			navigate(signInDestination());
			return;
		}
		error.value = result.message;
		loading.value = false;
	});

	const handlePasskey = $(async () => {
		if (loading.value) return;
		error.value = '';
		loading.value = true;
		// Modal only, like GitHub: no conditional (autofill) ceremony runs in the background, because aborting it to start
		// this one breaks extension-based passkey providers (NordPass, 1Password, Bitwarden).
		const result = await loginWithPasskey();
		if (result.ok) {
			navigate(signInDestination());
			return;
		}
		error.value = result.message;
		loading.value = false;
	});

	const appleUnavailable = useSignal(false);
	// Load Apple's SDK once the Apple button is on screen, so the click can open Apple's popup immediately (Safari blocks
	// popups opened after an async script download).
	useVisibleTask$(({ track }) => {
		if (track(() => appleClientId.value)) void preloadAppleSdk();
	});
	const handleApple = $(async () => {
		if (loading.value) return;
		error.value = '';
		appleUnavailable.value = false;
		loading.value = true;
		const outcome = await signInWithApple(appleClientId.value);
		if (outcome.status === 'cancelled') {
			loading.value = false;
			return;
		}
		if (outcome.status === 'unavailable') {
			appleUnavailable.value = true;
			loading.value = false;
			return;
		}
		const result = await loginWithApple(outcome.identityToken);
		if (result.ok) {
			navigate(signInDestination());
			return;
		}
		error.value = result.message;
		loading.value = false;
	});

	// Google sign-in: the button lives in the sign-in view only, so it is rendered again whenever that view returns.
	useVisibleTask$(async ({ track }) => {
		const current = track(() => view.value);
		track(() => googleAttempt.value);
		const clientId = googleClientId.value;
		if (!clientId || current !== 'signin') return;
		const container = document.getElementById('google-signin-button');
		if (!container) return;
		googleUnavailable.value = false;
		googleUnavailable.value = !(await renderGoogleButton(container, clientId, handleGoogleCredential));
	});

	// Turnstile: one widget for the whole screen. Script or render failure is shown to the shopper, never silent.
	useVisibleTask$(() => {
		if (!TURNSTILE_SITE_KEY) return;
		const fail = () => {
			widgetError.value = true;
		};
		(window as any).onTurnstileLoad = () => {
			const container = document.getElementById('turnstile-container');
			if (!container || !(window as any).turnstile) return fail();
			try {
				widgetId.value = (window as any).turnstile.render(container, {
					sitekey: TURNSTILE_SITE_KEY,
					theme: 'light',
					callback: (token: string) => {
						turnstileToken.value = token;
					},
					'expired-callback': () => {
						turnstileToken.value = '';
					},
					'error-callback': fail,
				});
			} catch {
				fail();
			}
		};
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
		script.async = true;
		script.onerror = fail;
		document.head.appendChild(script);
	});

	// Readiness mirrors the handler guards, so a grey button never submits and a ready one always does.
	const tokenOk = !TURNSTILE_SITE_KEY || turnstileToken.value.length > 0;
	const emailReady = EMAIL_RE.test(email.value.trim());
	const signinReady = emailReady && password.value.trim().length > 0;
	const signupReady =
		emailReady &&
		firstName.value.trim().length > 0 &&
		lastName.value.trim().length > 0 &&
		password.value.length >= 8 &&
		password.value === confirmPassword.value;

	const handleSignIn = $(async () => {
		if (!(EMAIL_RE.test(email.value.trim()) && password.value.trim().length > 0 && (!TURNSTILE_SITE_KEY || turnstileToken.value.length > 0)) || loading.value) return;
		error.value = '';
		loading.value = true;
		const result = await login(email.value.trim(), password.value, {
			turnstileToken: turnstileToken.value,
			rememberMe: rememberMe.value,
		});
		if (result.ok) {
			navigate(signInDestination());
			return;
		}
		if (result.code === 'not_verified') {
			view.value = 'verify-needed';
		} else if (result.code === 'invalid_credentials') {
			// One generic message for every credential failure: never reveal whether the account exists.
			error.value = magicLinkEnabled.value
				? `${BAD_CREDENTIALS_HINT} Reset your password or email yourself a sign-in link.`
				: `${BAD_CREDENTIALS_HINT} Reset your password.`;
		} else {
			error.value = result.message;
		}
		await resetChallenge();
		loading.value = false;
	});

	const handleSignUp = $(async () => {
		if (!(EMAIL_RE.test(email.value.trim()) && firstName.value.trim().length > 0 && lastName.value.trim().length > 0 && password.value.length >= 8 && password.value === confirmPassword.value && (!TURNSTILE_SITE_KEY || turnstileToken.value.length > 0)) || loading.value) return;
		error.value = '';
		loading.value = true;
		const result = await registerCustomerFromSignup({
			email: email.value,
			password: password.value,
			confirmPassword: confirmPassword.value,
			firstName: firstName.value,
			lastName: lastName.value,
			turnstileToken: turnstileToken.value,
		});
		await resetChallenge();
		if (result.step === 'success') view.value = 'success';
		else if (result.step === 'signin') view.value = 'signin';
		if (result.error) error.value = result.error;
		loading.value = false;
	});

	const handleForgotPassword = $(async () => {
		if (loading.value) return;
		error.value = '';
		// An empty or malformed email prompts for it instead of doing nothing (the button is only visually greyed).
		if (!email.value.trim()) { error.value = 'Enter your email address above, then choose Reset it.'; return; }
		if (!EMAIL_RE.test(email.value.trim())) { error.value = 'Please enter a valid email address.'; return; }
		if (TURNSTILE_SITE_KEY && !turnstileToken.value) { error.value = TOKEN_MISSING_HINT; return; }
		loading.value = true;
		// The API answers 200 whether or not an account exists, so only a 200 is shown as "check your email";
		// a 403/429/transport failure is shown as the failure it is (previous-platform parity, #389).
		const result = await requestPasswordReset(email.value.trim(), turnstileToken.value);
		await resetChallenge();
		if (result.ok) view.value = 'reset-sent';
		else error.value = passwordResetFailureMessage(result);
		loading.value = false;
	});

	const handleMagicLink = $(async () => {
		if (!(EMAIL_RE.test(email.value.trim()) && (!TURNSTILE_SITE_KEY || turnstileToken.value.length > 0)) || loading.value) return;
		error.value = '';
		loading.value = true;
		// Enumeration-safe on the API side (identical 200 for an unknown address) — so is the screen that follows.
		const result = await requestMagicLink(email.value.trim(), turnstileToken.value);
		await resetChallenge();
		loading.value = false;
		if (result.ok) view.value = 'magic-sent';
		else error.value = result.message;
	});

	const goToView = $((next: View) => {
		error.value = '';
		password.value = '';
		confirmPassword.value = '';
		firstName.value = '';
		lastName.value = '';
		resendSent.value = false;
		view.value = next;
	});

	const handleResendVerification = $(async () => {
		if (!(EMAIL_RE.test(email.value.trim()) && (!TURNSTILE_SITE_KEY || turnstileToken.value.length > 0)) || resendLoading.value) return;
		resendLoading.value = true;
		await resendVerification(email.value.trim(), turnstileToken.value);
		await resetChallenge();
		resendLoading.value = false;
		resendSent.value = true;
	});

	const showWidget = view.value === 'signin' || view.value === 'signup' || view.value === 'verify-needed';
	const hint = (fieldsReady: boolean) => {
		if (widgetError.value) return TOKEN_FAILED_HINT;
		if (fieldsReady && !tokenOk) return TOKEN_MISSING_HINT;
		return '';
	};
	const primaryHint = hint(view.value === 'signup' ? signupReady : signinReady);

	return (
		<div class="min-h-screen bg-[var(--color-parchment)] flex items-start justify-center py-16 px-4 sm:px-6 lg:px-8">
			<div class="w-full max-w-md">
				<div class="bg-[var(--color-parchment)] rounded-2xl p-8 shadow-sm">
					{view.value === 'signin' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="font-heading text-2xl font-bold text-[var(--color-ink)]">Sign in</h1>
								<p class="mt-2 text-sm text-[var(--color-ink-soft)]">Welcome back</p>
							</div>
							{passwordResetDone.value && (
								<p class="mb-5 rounded-md bg-green-50 p-3 text-sm text-green-800" role="status" data-testid="password-reset-success">
									Your password has been updated. Sign in with your new password.
								</p>
							)}
							<div class="space-y-5">
								<div>
									<label class="block text-sm font-medium text-[var(--color-ink-soft)]">Email address</label>
									<input
										type="email"
										autoComplete="email"
										autoFocus
										value={email.value}
										onInput$={(_, el) => (email.value = el.value)}
										class={INPUT}
										placeholder="you@example.com"
									/>
								</div>
								<div>
									<label class="block text-sm font-medium text-[var(--color-ink-soft)]">Password</label>
									<input
										type="password"
										autoComplete="current-password"
										value={password.value}
										onInput$={(_, el) => (password.value = el.value)}
										onKeyUp$={(ev) => {
											if (ev.key === 'Enter') handleSignIn();
										}}
										class={INPUT}
									/>
								</div>
								<label class="flex items-center gap-2 text-sm text-[var(--color-ink-soft)] cursor-pointer">
									<input
										type="checkbox"
										checked
										onChange$={(_, el) => (rememberMe.value = el.checked)}
										class="h-4 w-4 text-[var(--color-accent)] focus:ring-[var(--color-accent)] border-[var(--color-card-border)] rounded-sm"
									/>
									Remember me
								</label>
							</div>
						</div>
					)}

					{view.value === 'signup' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="font-heading text-2xl font-bold text-[var(--color-ink)]">Create your account</h1>
							</div>
							<div class="space-y-5">
								<div class="grid grid-cols-2 gap-4">
									<div>
										<label class="block text-sm font-medium text-[var(--color-ink-soft)]">First name</label>
										<input type="text" autoComplete="given-name" autoFocus value={firstName.value} onInput$={(_, el) => (firstName.value = el.value)} class={INPUT} />
									</div>
									<div>
										<label class="block text-sm font-medium text-[var(--color-ink-soft)]">Last name</label>
										<input type="text" autoComplete="family-name" value={lastName.value} onInput$={(_, el) => (lastName.value = el.value)} class={INPUT} />
									</div>
								</div>
								<div>
									<label class="block text-sm font-medium text-[var(--color-ink-soft)]">Email address</label>
									<input type="email" autoComplete="email" value={email.value} onInput$={(_, el) => (email.value = el.value)} class={INPUT} placeholder="you@example.com" />
								</div>
								<div>
									<label class="block text-sm font-medium text-[var(--color-ink-soft)]">Password</label>
									<input type="password" autoComplete="new-password" value={password.value} onInput$={(_, el) => (password.value = el.value)} class={INPUT} />
								</div>
								<div>
									<label class="block text-sm font-medium text-[var(--color-ink-soft)]">Confirm password</label>
									<input
										type="password"
										autoComplete="new-password"
										value={confirmPassword.value}
										onInput$={(_, el) => (confirmPassword.value = el.value)}
										onKeyUp$={(ev) => {
											if (ev.key === 'Enter') handleSignUp();
										}}
										class={INPUT}
									/>
								</div>
							</div>
						</div>
					)}

					<div id="turnstile-container" class={showWidget && TURNSTILE_SITE_KEY ? 'min-h-[65px] flex justify-center mt-5' : 'hidden'}></div>

					{showWidget && error.value && (
						<div class="mt-5">
							<SignInError message={error.value} />
						</div>
					)}

					{view.value === 'signin' && (
						<div class="mt-5 space-y-3">
							<button
								key={`signin-submit-${loading.value}`}
								onClick$={handleSignIn}
								disabled={loading.value}
								aria-disabled={(signinReady && tokenOk) ? 'false' : 'true'}
								class={PRIMARY}
							>
								{loading.value ? 'Signing in...' : 'Sign in'}
							</button>
							{primaryHint && <p class="text-xs text-[var(--color-ink-soft)] text-center">{primaryHint}</p>}
							{googleClientId.value && (
								<>
									<div class="flex items-center gap-3">
										<div class="h-px flex-1 bg-[var(--color-card-border)]"></div>
										<span class="text-xs text-[var(--color-ink-soft)]">or</span>
										<div class="h-px flex-1 bg-[var(--color-card-border)]"></div>
									</div>
									<div id="google-signin-button" data-testid="google-signin-button" class="flex justify-center min-h-[44px]"></div>
									{googleUnavailable.value && (
										<p class="text-xs text-[var(--color-ink-soft)] text-center" role="status" data-testid="google-signin-unavailable">
											Google sign-in is unavailable right now.{' '}
											<button type="button" class="underline cursor-pointer" onClick$={() => googleAttempt.value++}>
												Try again
											</button>
										</p>
									)}
								</>
							)}
							{(passkeySupported.value || appleClientId.value) && (
								<>
									{!googleClientId.value && (
										<div class="flex items-center gap-3">
											<div class="h-px flex-1 bg-[var(--color-card-border)]"></div>
											<span class="text-xs text-[var(--color-ink-soft)]">or</span>
											<div class="h-px flex-1 bg-[var(--color-card-border)]"></div>
										</div>
									)}
									{passkeySupported.value && (
										<button type="button" onClick$={handlePasskey} disabled={loading.value} data-testid="passkey-signin-button" class={PROVIDER_BUTTON}>
											Sign in with a passkey
										</button>
									)}
									{appleClientId.value && (
										<>
											<button type="button" onClick$={handleApple} disabled={loading.value} id="apple-signin-button" data-testid="apple-signin-button" class={APPLE_BUTTON}>
												Sign in with Apple
											</button>
											{appleUnavailable.value && (
												<p class="text-xs text-[var(--color-ink-soft)] text-center" role="status" data-testid="apple-signin-unavailable">
													Apple sign-in is unavailable right now. Please try again.
												</p>
											)}
										</>
									)}
								</>
							)}
							<div class="text-center text-sm text-[var(--color-ink-soft)] space-y-2 pt-2">
								<p>
									<button
										key={`password-reset-${loading.value}`}
										type="button"
										onClick$={handleForgotPassword}
										disabled={loading.value}
										aria-disabled={(emailReady && tokenOk) ? 'false' : 'true'}
										class="link-ready text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] underline cursor-pointer"
									>
										Forgot your password? Reset it
									</button>
								</p>
								{/* #401: the links wait for the security check; say so instead of a silent aria-disabled. */}
								{TURNSTILE_SITE_KEY && emailReady && !tokenOk && <p class="text-xs" role="status">{TOKEN_MISSING_HINT}</p>}
								{magicLinkEnabled.value && (
									<p>
										<button
											key={`magic-link-${loading.value}`}
											type="button"
											onClick$={handleMagicLink}
											disabled={loading.value}
											aria-disabled={(emailReady && tokenOk) ? 'false' : 'true'}
											data-testid="magic-link-request"
											class="link-ready text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] underline cursor-pointer"
										>
											Email me a sign-in link
										</button>
									</p>
								)}
								<p>
									New here?{' '}
									<button type="button" onClick$={() => goToView('signup')} class="text-[var(--color-accent)] hover:text-[var(--color-ink)] underline cursor-pointer">
										Create an account
									</button>
								</p>
							</div>
						</div>
					)}

					{view.value === 'signup' && (
						<div class="mt-5 space-y-3">
							<button
								key={`signup-submit-${loading.value}`}
								onClick$={handleSignUp}
								disabled={loading.value}
								aria-disabled={(signupReady && tokenOk) ? 'false' : 'true'}
								class={PRIMARY}
							>
								{loading.value ? 'Creating account...' : 'Create account'}
							</button>
							{primaryHint && <p class="text-xs text-[var(--color-ink-soft)] text-center">{primaryHint}</p>}
							<p class="text-center text-sm text-[var(--color-ink-soft)]">
								Already have an account?{' '}
								<button type="button" onClick$={() => goToView('signin')} class="text-[var(--color-accent)] hover:text-[var(--color-ink)] underline cursor-pointer">
									Sign in
								</button>
							</p>
						</div>
					)}

					{/* ── Registration success ── */}
					{view.value === 'success' && (
						<div class="text-center py-4">
							<div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-[var(--color-parchment)] mb-4">
								<svg class="h-6 w-6 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
								</svg>
							</div>
							<h2 class="font-heading text-lg font-medium text-[var(--color-ink)] mb-2">Check your email</h2>
							<p class="text-sm text-[var(--color-ink-soft)] mb-6">
								We sent a verification link to <span class="font-medium">{email.value}</span>. Click the link to activate your account.
							</p>
							<button onClick$={() => goToView('signin')} class="text-sm text-[var(--color-accent)] hover:text-[var(--color-ink)] underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Unverified account tried to sign in ── */}
					{view.value === 'verify-needed' && (
						<div class="text-center py-4">
							<h2 class="font-heading text-lg font-medium text-[var(--color-ink)] mb-2">Verify your email</h2>
							<p class="text-sm text-[var(--color-ink-soft)] mb-6">
								Your password is correct, but <span class="font-medium">{email.value}</span> hasn't been verified yet.
								Check your inbox for the verification link{resendSent.value ? ' — we just sent another one.' : '.'}
							</p>
							<button
								onClick$={handleResendVerification}
								disabled={resendLoading.value || resendSent.value}
								aria-disabled={resendSent.value || !(emailReady && tokenOk) ? 'true' : 'false'}
								class={`${PRIMARY} mb-3`}
							>
								{resendLoading.value ? 'Sending...' : resendSent.value ? 'Verification email sent' : 'Resend verification email'}
							</button>
							{!resendSent.value && hint(emailReady) && <p class="text-xs text-[var(--color-ink-soft)] mb-3">{hint(emailReady)}</p>}
							<button onClick$={() => goToView('signin')} class="text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Sign-in link sent ── */}
					{view.value === 'magic-sent' && (
						<div class="text-center py-4" data-testid="magic-link-sent">
							<h2 class="font-heading text-lg font-medium text-[var(--color-ink)] mb-2">Check your email</h2>
							<p class="text-sm text-[var(--color-ink-soft)] mb-6">
								If an account exists for <span class="font-medium">{email.value}</span>, we've sent a link that signs you in. It works once and expires soon.
							</p>
							<button onClick$={() => goToView('signin')} class="text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Password reset sent ── */}
					{view.value === 'reset-sent' && (
						<div class="text-center py-4">
							<h2 class="font-heading text-lg font-medium text-[var(--color-ink)] mb-2">Check your email</h2>
							<p class="text-sm text-[var(--color-ink-soft)] mb-6">
								If an account exists for <span class="font-medium">{email.value}</span>, we've sent instructions to reset your password.
							</p>
							<button onClick$={() => goToView('signin')} class="text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
