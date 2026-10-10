import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { registerCustomerFromSignup } from '~/components/auth/signup-flow';
import { login, requestMagicLink, requestPasswordReset, resendVerification } from '~/providers/shop/account/account';
import { getShopConfig } from '~/providers/shop/checkout/checkout';
import { SignInError } from './SignInError';
export { head } from './seo';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAD_CREDENTIALS_HINT = "That email and password don't match.";
const TOKEN_MISSING_HINT = 'Complete the verification above to continue.';
const TOKEN_FAILED_HINT = "Verification couldn't load. Refresh the page or try another browser.";

type View = 'signin' | 'signup' | 'success' | 'reset-sent' | 'magic-sent' | 'verify-needed';

const PRIMARY =
	'w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer btn-ready';
const INPUT =
	'mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white';

export default component$(() => {
	const navigate = useNavigate();

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
	const resendLoading = useSignal(false);
	const resendSent = useSignal(false);
	/** Whether this store has passwordless sign-in links switched on (GET /v1/shop/config) — offered only when it has. */
	const magicLinkEnabled = useSignal(false);

	const resetChallenge = $(() => {
		turnstileToken.value = '';
		if (widgetId.value) (window as any).turnstile?.reset(widgetId.value);
	});

	useVisibleTask$(async () => {
		try {
			magicLinkEnabled.value = !!(await getShopConfig()).auth?.magicLink;
		} catch {
			magicLinkEnabled.value = false; // fail closed: no link option rather than one that errors
		}
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
			navigate('/account');
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
		if (!(EMAIL_RE.test(email.value.trim()) && (!TURNSTILE_SITE_KEY || turnstileToken.value.length > 0)) || loading.value) return;
		error.value = '';
		loading.value = true;
		// Enumeration-safe on the API side — always resolves ok, so this always shows the same "check your email" state.
		await requestPasswordReset(email.value.trim(), turnstileToken.value);
		await resetChallenge();
		view.value = 'reset-sent';
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
		<div class="min-h-screen bg-gray-50 flex items-start justify-center py-16 px-4 sm:px-6 lg:px-8">
			<div class="w-full max-w-md">
				<div class="bg-[#F9F7F4] rounded-2xl p-8 shadow-sm">
					{view.value === 'signin' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="text-2xl font-bold text-gray-900">Sign in</h1>
								<p class="mt-2 text-sm text-gray-600">Welcome back</p>
							</div>
							<div class="space-y-5">
								<div>
									<label class="block text-sm font-medium text-gray-700">Email address</label>
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
									<label class="block text-sm font-medium text-gray-700">Password</label>
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
								<label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
									<input
										type="checkbox"
										checked
										onChange$={(_, el) => (rememberMe.value = el.checked)}
										class="h-4 w-4 text-[var(--color-accent)] focus:ring-[var(--color-accent)] border-gray-300 rounded-sm"
									/>
									Remember me
								</label>
							</div>
						</div>
					)}

					{view.value === 'signup' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="text-2xl font-bold text-gray-900">Create your account</h1>
							</div>
							<div class="space-y-5">
								<div class="grid grid-cols-2 gap-4">
									<div>
										<label class="block text-sm font-medium text-gray-700">First name</label>
										<input type="text" autoComplete="given-name" autoFocus value={firstName.value} onInput$={(_, el) => (firstName.value = el.value)} class={INPUT} />
									</div>
									<div>
										<label class="block text-sm font-medium text-gray-700">Last name</label>
										<input type="text" autoComplete="family-name" value={lastName.value} onInput$={(_, el) => (lastName.value = el.value)} class={INPUT} />
									</div>
								</div>
								<div>
									<label class="block text-sm font-medium text-gray-700">Email address</label>
									<input type="email" autoComplete="email" value={email.value} onInput$={(_, el) => (email.value = el.value)} class={INPUT} placeholder="you@example.com" />
								</div>
								<div>
									<label class="block text-sm font-medium text-gray-700">Password</label>
									<input type="password" autoComplete="new-password" value={password.value} onInput$={(_, el) => (password.value = el.value)} class={INPUT} />
								</div>
								<div>
									<label class="block text-sm font-medium text-gray-700">Confirm password</label>
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
							{primaryHint && <p class="text-xs text-gray-500 text-center">{primaryHint}</p>}
							<div class="text-center text-sm text-gray-600 space-y-2 pt-2">
								<p>
									<button
										key={`password-reset-${loading.value}`}
										type="button"
										onClick$={handleForgotPassword}
										disabled={loading.value}
										aria-disabled={(emailReady && tokenOk) ? 'false' : 'true'}
										class="link-ready text-gray-600 hover:text-gray-800 underline cursor-pointer"
									>
										Forgot your password? Reset it
									</button>
								</p>
								{magicLinkEnabled.value && (
									<p>
										<button
											key={`magic-link-${loading.value}`}
											type="button"
											onClick$={handleMagicLink}
											disabled={loading.value}
											aria-disabled={(emailReady && tokenOk) ? 'false' : 'true'}
											data-testid="magic-link-request"
											class="link-ready text-gray-600 hover:text-gray-800 underline cursor-pointer"
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
							{primaryHint && <p class="text-xs text-gray-500 text-center">{primaryHint}</p>}
							<p class="text-center text-sm text-gray-600">
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
							<h2 class="text-lg font-medium text-[var(--color-ink)] mb-2">Check your email</h2>
							<p class="text-sm text-gray-600 mb-6">
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
							<h2 class="text-lg font-medium text-gray-900 mb-2">Verify your email</h2>
							<p class="text-sm text-gray-600 mb-6">
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
							{!resendSent.value && hint(emailReady) && <p class="text-xs text-gray-500 mb-3">{hint(emailReady)}</p>}
							<button onClick$={() => goToView('signin')} class="text-sm text-gray-600 hover:text-gray-800 underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Sign-in link sent ── */}
					{view.value === 'magic-sent' && (
						<div class="text-center py-4" data-testid="magic-link-sent">
							<h2 class="text-lg font-medium text-gray-900 mb-2">Check your email</h2>
							<p class="text-sm text-gray-600 mb-6">
								If an account exists for <span class="font-medium">{email.value}</span>, we've sent a link that signs you in. It works once and expires soon.
							</p>
							<button onClick$={() => goToView('signin')} class="text-sm text-gray-600 hover:text-gray-800 underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Password reset sent ── */}
					{view.value === 'reset-sent' && (
						<div class="text-center py-4">
							<h2 class="text-lg font-medium text-gray-900 mb-2">Check your email</h2>
							<p class="text-sm text-gray-600 mb-6">
								If an account exists for <span class="font-medium">{email.value}</span>, we've sent instructions to reset your password.
							</p>
							<button onClick$={() => goToView('signin')} class="text-sm text-gray-600 hover:text-gray-800 underline cursor-pointer">
								Back to sign in
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
