import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { registerCustomerFromSignup } from '~/components/auth/signup-flow';
import { loginMutation, registerCustomerAccountMutation, requestPasswordResetMutation, resendVerificationMutation } from '~/providers/shop/account/account';
import { checkCustomerEmail } from '~/providers/shop/account/check-email';
import { SignInError } from './SignInError';
export { head } from './seo';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

type Step = 'email' | 'signin' | 'signup' | 'success' | 'reset-sent' | 'verify-needed';

export default component$(() => {
	const navigate = useNavigate();

	const step = useSignal<Step>('email');
	const email = useSignal('');
	const password = useSignal('');
	const confirmPassword = useSignal('');
	const firstName = useSignal('');
	const lastName = useSignal('');
	const rememberMe = useSignal(true);
	const error = useSignal('');
	const loading = useSignal(false);
	const turnstileToken = useSignal('');
	const honeypot = useSignal('');
	const resendLoading = useSignal(false);
	const resendSent = useSignal(false);
	const widgetId = useSignal<string>();
	const resetChallenge = $(() => {
		turnstileToken.value = '';
		if (widgetId.value) (window as any).turnstile?.reset(widgetId.value);
	});

	// Load Turnstile
	useVisibleTask$(() => {
		if (!TURNSTILE_SITE_KEY) return;
		(window as any).onTurnstileLoad = () => {
			const container = document.getElementById('turnstile-container');
			if (container && (window as any).turnstile) {
				widgetId.value = (window as any).turnstile.render(container, {
					sitekey: TURNSTILE_SITE_KEY,
					theme: 'light',
					callback: (token: string) => { turnstileToken.value = token; },
					'expired-callback': () => { turnstileToken.value = ''; },
				});
			}
		};
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
		script.async = true;
		document.head.appendChild(script);
	});

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	const handleEmailContinue = $(async () => {
		error.value = '';
		const trimmed = email.value.trim();
		if (!trimmed) {
			error.value = 'Please enter your email address.';
			return;
		}
		if (!emailRegex.test(trimmed)) {
			error.value = 'Please enter a valid email address.';
			return;
		}
		if (TURNSTILE_SITE_KEY && !turnstileToken.value) {
			error.value = 'Please complete the security check.';
			return;
		}
		loading.value = true;
		const exists = await checkCustomerEmail(trimmed, turnstileToken.value, honeypot.value);
		await resetChallenge();
		loading.value = false;
		step.value = exists ? 'signin' : 'signup';
	});

	const handleSignIn = $(async () => {
		error.value = '';
		if (TURNSTILE_SITE_KEY && !turnstileToken.value) {
			error.value = 'Please complete the security check.';
			return;
		}
		if (!password.value.trim()) {
			error.value = 'Please enter your password.';
			return;
		}
		loading.value = true;
		try {
			const { login } = await loginMutation(email.value.trim(), password.value, rememberMe.value, turnstileToken.value);
			if (login.__typename === 'CurrentUser') {
				navigate('/account');
			} else if ((login as any).__typename === 'NotVerifiedError') {
				step.value = 'verify-needed';
			} else {
				const msg = (login as any).message?.toLowerCase() || '';
				if (msg.includes('verify') || msg.includes('verification')) {
					step.value = 'verify-needed';
				} else {
					error.value = 'Invalid email or password.';
				}
			}
		} catch {
			error.value = 'An unexpected error occurred. Please try again.';
		}
		await resetChallenge();
		loading.value = false;
	});

	const handleSignUp = $(async () => {
		error.value = '';
		if (TURNSTILE_SITE_KEY && !turnstileToken.value) {
			error.value = 'Please complete the security check.';
			return;
		}
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
		if (result.step) step.value = result.step;
		if (result.error) error.value = result.error;
		loading.value = false;
	});

	const handleForgotPassword = $(async () => {
		error.value = '';
		loading.value = true;
		try {
			const result = await requestPasswordResetMutation(email.value.trim());
			if (result?.__typename === 'Success') {
				step.value = 'reset-sent';
			} else {
				// For unverified users, requestPasswordReset may fail —
				// re-register them which re-sends verification
				const result2 = await registerCustomerAccountMutation({
					input: {
						emailAddress: email.value.trim(),
						firstName: '',
						lastName: '',
					},
				});
				if (result2?.registerCustomerAccount?.__typename === 'Success') {
					step.value = 'reset-sent';
				} else {
					step.value = 'reset-sent'; // Still show success to avoid email enumeration
				}
			}
		} catch {
			step.value = 'reset-sent'; // Always show success
		}
		loading.value = false;
	});

	const handleBack = $(() => {
		error.value = '';
		password.value = '';
		confirmPassword.value = '';
		firstName.value = '';
		lastName.value = '';
		resendSent.value = false;
		step.value = 'email';
	});

	const handleResendVerification = $(async () => {
		resendLoading.value = true;
		await resendVerificationMutation(email.value.trim());
		resendLoading.value = false;
		resendSent.value = true;
	});

	return (
		<div class="min-h-screen bg-gray-50 flex items-start justify-center py-16 px-4 sm:px-6 lg:px-8">
			<div class="w-full max-w-md">
				<div class="bg-[#F9F7F4] rounded-2xl p-8 shadow-sm">

					<div id="turnstile-container" class={['email', 'signin', 'signup'].includes(step.value) ? 'min-h-[65px] flex justify-center mb-4' : 'hidden'}></div>
					{step.value === 'email' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="text-2xl font-bold text-gray-900">Welcome</h1>
								<p class="mt-2 text-sm text-gray-600">Enter your email to continue</p>
							</div>
							<div class="space-y-5">
								{/* Honeypot — hidden from humans */}
								<input
									type="text"
									name="website"
									autoComplete="off"
									tabIndex={-1}
									aria-hidden="true"
									class="!absolute !-left-[9999px] !top-0 !h-0 !w-0 !overflow-hidden"
									value={honeypot.value}
									onInput$={(_, el) => (honeypot.value = el.value)}
								/>
								<div>
									<label class="block text-sm font-medium text-gray-700">Email address</label>
									<input
										type="email"
										autoComplete="email"
										autoFocus
										value={email.value}
										onInput$={(_, el) => (email.value = el.value)}
										onKeyUp$={(ev) => {
											if (ev.key === 'Enter') handleEmailContinue();
										}}
										class="mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
										placeholder="you@example.com"
									/>
								</div>
								{error.value && (
									<SignInError message={error.value} />
								)}
								<button
									key={`email-continue-${loading.value}`}
									onClick$={handleEmailContinue}
									disabled={loading.value}
									class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
								>
									{loading.value ? 'Checking...' : 'Continue'}
								</button>
							</div>
						</div>
					)}

					{step.value === 'signin' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="text-2xl font-bold text-gray-900">Welcome back</h1>
								<p class="mt-2 text-sm text-gray-600">{email.value}</p>
								<button onClick$={handleBack} class="text-xs text-gray-500 hover:text-gray-700 underline mt-1 cursor-pointer">
									Use a different email
								</button>
							</div>
							<div class="space-y-5">
								<div>
									<label class="block text-sm font-medium text-gray-700">Password</label>
									<input
										type="password"
										autoComplete="current-password"
										autoFocus
										value={password.value}
										onInput$={(_, el) => (password.value = el.value)}
										onKeyUp$={(ev) => {
											if (ev.key === 'Enter') handleSignIn();
										}}
										class="mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
									/>
								</div>
								<div class="flex items-center justify-between">
									<label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
										<input
											type="checkbox"
											checked
											onChange$={(_, el) => (rememberMe.value = el.checked)}
											class="h-4 w-4 text-[var(--color-accent)] focus:ring-[var(--color-accent)] border-gray-300 rounded-sm"
										/>
										Remember me
									</label>
									<button
										key={`password-reset-${loading.value}`}
										onClick$={handleForgotPassword}
										disabled={loading.value}
										class="text-sm text-gray-600 hover:text-gray-800 cursor-pointer underline"
									>
										Forgot password?
									</button>
								</div>
								{error.value && (
									<SignInError message={error.value} />
								)}
								<button
									key={`signin-submit-${loading.value}`}
									onClick$={handleSignIn}
									disabled={loading.value}
									class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
								>
									{loading.value ? 'Signing in...' : 'Sign In'}
								</button>
							</div>
						</div>
					)}

					{/* ── Step: Sign Up (new account) ── */}
					{step.value === 'signup' && (
						<div>
							<div class="text-center mb-8">
								<h1 class="text-2xl font-bold text-gray-900">Create your account</h1>
								<p class="mt-2 text-sm text-gray-600">{email.value}</p>
								<button onClick$={handleBack} class="text-xs text-gray-500 hover:text-gray-700 underline mt-1 cursor-pointer">
									Use a different email
								</button>
							</div>
							<div class="space-y-5">
								<div class="grid grid-cols-2 gap-4">
									<div>
										<label class="block text-sm font-medium text-gray-700">First name</label>
										<input
											type="text"
											autoComplete="given-name"
											autoFocus
											value={firstName.value}
											onInput$={(_, el) => (firstName.value = el.value)}
											class="mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
										/>
									</div>
									<div>
										<label class="block text-sm font-medium text-gray-700">Last name</label>
										<input
											type="text"
											autoComplete="family-name"
											value={lastName.value}
											onInput$={(_, el) => (lastName.value = el.value)}
											class="mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
										/>
									</div>
								</div>
								<div>
									<label class="block text-sm font-medium text-gray-700">Password</label>
									<input
										type="password"
										autoComplete="new-password"
										value={password.value}
										onInput$={(_, el) => (password.value = el.value)}
										class="mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
									/>
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
										class="mt-1 appearance-none block w-full px-3 py-2.5 border border-gray-300 rounded-md shadow-xs placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-gray-500 focus:border-gray-500 sm:text-sm bg-white"
									/>
								</div>
								{error.value && (
									<SignInError message={error.value} />
								)}
								<button
									key={`signup-submit-${loading.value}`}
									onClick$={handleSignUp}
									disabled={loading.value}
									class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
								>
									{loading.value ? 'Creating account...' : 'Create Account'}
								</button>
							</div>
						</div>
					)}

					{/* ── Step: Registration success ── */}
					{step.value === 'success' && (
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
							<button
								onClick$={handleBack}
								class="text-sm text-[var(--color-accent)] hover:text-[var(--color-ink)] underline cursor-pointer"
							>
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Step: unverified account tried to sign in ── */}
					{step.value === 'verify-needed' && (
						<div class="text-center py-4">
							<div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-[var(--color-parchment)] mb-4">
								<svg class="h-6 w-6 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
								</svg>
							</div>
							<h2 class="text-lg font-medium text-gray-900 mb-2">Verify your email</h2>
							<p class="text-sm text-gray-600 mb-6">
								Your password is correct, but <span class="font-medium">{email.value}</span> hasn't been verified yet.
								Check your inbox for the verification link{resendSent.value ? ' — we just sent another one.' : '.'}
							</p>
							<button
								onClick$={handleResendVerification}
								disabled={resendLoading.value || resendSent.value}
								class="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--color-accent)] hover:bg-[#4F3B26] focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed mb-3"
							>
								{resendLoading.value ? 'Sending...' : resendSent.value ? 'Verification email sent' : 'Resend verification email'}
							</button>
							<button
								onClick$={handleBack}
								class="text-sm text-gray-600 hover:text-gray-800 underline cursor-pointer"
							>
								Back to sign in
							</button>
						</div>
					)}

					{/* ── Step: Password reset sent ── */}
					{step.value === 'reset-sent' && (
						<div class="text-center py-4">
							<div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-[var(--color-parchment)] mb-4">
								<svg class="h-6 w-6 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
								</svg>
							</div>
							<h2 class="text-lg font-medium text-gray-900 mb-2">Check your email</h2>
							<p class="text-sm text-gray-600 mb-6">
								If an account exists for <span class="font-medium">{email.value}</span>, we've sent instructions to reset your password.
							</p>
							<button
								onClick$={handleBack}
								class="text-sm text-gray-600 hover:text-gray-800 underline cursor-pointer"
							>
								Back to sign in
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
});
