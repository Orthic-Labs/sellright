// Brand views, plan §2.5 "Forms": the newsletter and contact submit logic, moved verbatim out of routes/index.tsx and
// routes/contact/index.tsx into plain functions over a small port, so the base pages and the brand views run ONE implementation and
// it can be unit-tested without Qwik. The port is the controller's private state (signals in the hooks); nothing here is exposed to a brand.
import type { FormResult } from '~/platform/views';

export type FormStatus = 'idle' | 'sending' | 'success' | 'error';

export interface FormPort {
	getStatus(): FormStatus;
	setStatus(status: FormStatus): void;
	setMessage(message: string): void;
	/** The solved Turnstile token ('' = none). */
	getToken(): string;
	clearToken(): void;
	/** Resets the (only) widget: a token is single-use. */
	resetWidget(): void;
	/** A Turnstile site key is configured, so a token is required before a submit. */
	turnstileRequired: boolean;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (port: FormPort, message: string, reason: Exclude<FormResult, { ok: true }>['reason']): FormResult => {
	port.setMessage(message);
	port.setStatus('error');
	return { ok: false, reason };
};

export interface NewsletterDeps {
	/** POST /newsletter-signup. Rejects on a network failure. */
	post(body: { email: string; honeypot: string; turnstileToken: string }): Promise<{ ok: boolean; status: number }>;
	/** Runs after a successful signup (the base page clears its email field). */
	onSuccess(): void;
}

/**
 * Newsletter signup (routes/index.tsx handleNewsletterSubmit). A submit while one is in flight is `busy` and makes no request;
 * validation runs first (an invalid email never posts); the server re-validates (newsletter-signup/index.ts).
 */
export async function submitNewsletter(port: FormPort, deps: NewsletterDeps, rawEmail: string, honeypot: string): Promise<FormResult> {
	if (port.getStatus() === 'sending') return { ok: false, reason: 'busy' };
	const email = rawEmail.trim();
	if (!email || !EMAIL_PATTERN.test(email)) return fail(port, 'Please enter a valid email.', 'invalid');
	if (port.turnstileRequired && !port.getToken()) return fail(port, 'Please complete the security check.', 'turnstile');
	const token = port.getToken();
	port.setStatus('sending');
	port.setMessage('');
	port.clearToken();
	port.resetWidget();
	try {
		const res = await deps.post({ email, honeypot, turnstileToken: token });
		if (!res.ok) {
			const msg =
				res.status === 429
					? 'Too many signups from this IP. Try again in an hour.'
					: res.status === 403
						? 'Security check failed. Please try again.'
						: 'Subscription failed. Please try again.';
			return fail(port, msg, 'server');
		}
		port.setStatus('success');
		deps.onSuccess();
		return { ok: true };
	} catch {
		return fail(port, 'Network error. Please try again.', 'server');
	}
}

export interface ContactFields {
	name: string;
	email: string;
	subject: string;
	message: string;
	honeypot: string;
}

export interface ContactDeps {
	/** The `server$` submit (providers/shop/contact). Rejects when the call itself fails. */
	send(payload: { name: string; email: string; subject: string; message: string; turnstileToken: string; honeypot: string }): Promise<{ success: boolean; message?: string }>;
}

/**
 * Contact form (routes/contact/index.tsx handleSubmit). The required fields and the email shape are checked first (nothing is sent on a malformed address), then the Turnstile token; a server
 * refusal resets the widget (single-use token) so a retry can verify again.
 */
export async function submitContact(port: FormPort, deps: ContactDeps, f: ContactFields): Promise<FormResult> {
	if (port.getStatus() === 'sending') return { ok: false, reason: 'busy' };
	if (!f.name.trim() || !f.email.trim() || !f.message.trim()) return fail(port, 'Please fill in all required fields.', 'invalid');
	// A brand view may submit from a button outside a <form>, where native email validation never runs.
	if (!EMAIL_PATTERN.test(f.email.trim())) return fail(port, 'Please enter a valid email.', 'invalid');
	if (!port.getToken() && port.turnstileRequired) return fail(port, 'Please complete the security check.', 'turnstile');
	port.setStatus('sending');
	try {
		const result = await deps.send({
			name: f.name.trim(),
			email: f.email.trim(),
			subject: f.subject,
			message: f.message.trim(),
			turnstileToken: port.getToken(),
			honeypot: f.honeypot,
		});
		if (result.success) {
			port.setStatus('success');
			return { ok: true };
		}
		port.clearToken();
		port.resetWidget();
		return fail(port, result.message || 'Something went wrong.', 'server');
	} catch {
		port.clearToken();
		port.resetWidget();
		return fail(port, 'Failed to send message. Please try again.', 'server');
	}
}
