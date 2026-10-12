// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ACTION_RESULTS, dispatch, type ActionCtl } from './callbacks';
import { submitContact, submitNewsletter, type FormPort, type FormStatus } from './forms';

const makePort = (over: Partial<{ token: string; turnstileRequired: boolean }> = {}) => {
	const s = { status: 'idle' as FormStatus, message: '', token: over.token ?? '', resets: 0, cleared: 0 };
	const port: FormPort = {
		getStatus: () => s.status,
		setStatus: (v) => { s.status = v; },
		setMessage: (m) => { s.message = m; },
		getToken: () => s.token,
		clearToken: () => { s.token = ''; s.cleared++; },
		resetWidget: () => { s.resets++; },
		turnstileRequired: over.turnstileRequired ?? true,
	};
	return { s, port };
};
const okPost = () => {
	const calls: unknown[] = [];
	return { calls, post: async (b: unknown) => { calls.push(b); return { ok: true, status: 200 }; }, onSuccess: () => { calls.push('success'); } };
};

describe('newsletter form', () => {
	it('an invalid email never posts, and says so', async () => {
		for (const bad of ['', '   ', 'plain', 'a@b', 'a b@c.d', '@x.y']) {
			const { s, port } = makePort({ token: 't' });
			const d = okPost();
			expect(await submitNewsletter(port, d, bad, ''), bad).toEqual({ ok: false, reason: 'invalid' });
			expect(d.calls).toEqual([]);
			expect(s.status).toBe('error');
			expect(s.message).toBe('Please enter a valid email.');
		}
	});

	it('a valid signup posts the trimmed email, the honeypot and the token, then succeeds', async () => {
		const { s, port } = makePort({ token: 'tok' });
		const d = okPost();
		expect(await submitNewsletter(port, d, '  a@b.co ', 'bot-filled')).toEqual({ ok: true });
		expect(d.calls).toEqual([{ email: 'a@b.co', honeypot: 'bot-filled', turnstileToken: 'tok' }, 'success']);
		expect(s.status).toBe('success');
	});

	it('Turnstile: required without a token is refused before any request; with no site key the form posts without one', async () => {
		const required = makePort({ token: '' });
		const d1 = okPost();
		expect(await submitNewsletter(required.port, d1, 'a@b.co', '')).toEqual({ ok: false, reason: 'turnstile' });
		expect(d1.calls).toEqual([]);
		expect(required.s.message).toBe('Please complete the security check.');
		const open = makePort({ token: '', turnstileRequired: false });
		const d2 = okPost();
		expect(await submitNewsletter(open.port, d2, 'a@b.co', '')).toEqual({ ok: true });
		expect(d2.calls[0]).toMatchObject({ turnstileToken: '' });
	});

	it('Turnstile: the token is cleared and the widget reset on every attempt that reaches the server', async () => {
		const { s, port } = makePort({ token: 'tok' });
		await submitNewsletter(port, okPost(), 'a@b.co', '');
		expect(s.token).toBe('');
		expect(s.resets).toBe(1);
	});

	it('maps 429 / 403 / other statuses and a network failure to the base messages', async () => {
		for (const [status, message] of [[429, 'Too many signups from this IP. Try again in an hour.'], [403, 'Security check failed. Please try again.'], [500, 'Subscription failed. Please try again.']] as const) {
			const { s, port } = makePort({ token: 't' });
			expect(await submitNewsletter(port, { post: async () => ({ ok: false, status }), onSuccess: () => undefined }, 'a@b.co', '')).toEqual({ ok: false, reason: 'server' });
			expect(s.message).toBe(message);
		}
		const { s, port } = makePort({ token: 't' });
		expect(await submitNewsletter(port, { post: async () => { throw new Error('offline'); }, onSuccess: () => undefined }, 'a@b.co', '')).toEqual({ ok: false, reason: 'server' });
		expect(s.message).toBe('Network error. Please try again.');
	});

	it('double submit: the second call is busy and exactly one request is made (through the dispatcher)', async () => {
		const { port } = makePort({ token: 't' });
		const ctl: ActionCtl = { disposed: false, admitted: [] };
		let requests = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const deps = { post: async () => { requests++; await gate; return { ok: true, status: 200 }; }, onSuccess: () => undefined };
		const FORM = { busy: { ok: false as const, reason: 'busy' as const }, disposed: { ok: false as const, reason: 'disposed' as const }, error: { ok: false as const, reason: 'server' as const } };
		const submit = () => dispatch(ctl, 'submit', FORM as never, () => submitNewsletter(port, deps, 'a@b.co', ''));
		const first = submit();
		const second = submit();
		expect(await second).toEqual({ ok: false, reason: 'busy' });
		release();
		expect(await first).toEqual({ ok: true });
		expect(requests).toBe(1);
	});

	it('the status guard alone also refuses a submit while one is in flight', async () => {
		const { s, port } = makePort({ token: 't' });
		s.status = 'sending';
		const d = okPost();
		expect(await submitNewsletter(port, d, 'a@b.co', '')).toEqual({ ok: false, reason: 'busy' });
		expect(d.calls).toEqual([]);
	});
});

describe('contact form', () => {
	const fields = { name: ' Ann ', email: ' a@b.co ', subject: 'GENERAL', message: ' hi ', honeypot: '' };

	it('missing required fields never post', async () => {
		for (const f of [{ ...fields, name: ' ' }, { ...fields, email: '' }, { ...fields, message: '  ' }]) {
			const { s, port } = makePort({ token: 't' });
			let sent = 0;
			expect(await submitContact(port, { send: async () => { sent++; return { success: true }; } }, f)).toEqual({ ok: false, reason: 'invalid' });
			expect(sent).toBe(0);
			expect(s.message).toBe('Please fill in all required fields.');
		}
	});

	it('a malformed email never posts, and does not consume the Turnstile token', async () => {
		for (const email of ['not-an-email', 'a@b', 'a b@c.co', '@b.co']) {
			const { s, port } = makePort({ token: 'tok' });
			let sent = 0;
			expect(await submitContact(port, { send: async () => { sent++; return { success: true }; } }, { ...fields, email })).toEqual({ ok: false, reason: 'invalid' });
			expect(sent, email).toBe(0);
			expect(s.message).toBe('Please enter a valid email.');
			expect(s.token).toBe('tok');
			expect(s.resets).toBe(0);
		}
	});

	it('Turnstile required without a token is refused; the honeypot is forwarded; fields are trimmed', async () => {
		const noToken = makePort({ token: '' });
		expect(await submitContact(noToken.port, { send: async () => ({ success: true }) }, fields)).toEqual({ ok: false, reason: 'turnstile' });
		const { port } = makePort({ token: 'tok' });
		let payload: unknown;
		expect(await submitContact(port, { send: async (p) => { payload = p; return { success: true }; } }, { ...fields, honeypot: 'bot' })).toEqual({ ok: true });
		expect(payload).toEqual({ name: 'Ann', email: 'a@b.co', subject: 'GENERAL', message: 'hi', turnstileToken: 'tok', honeypot: 'bot' });
	});

	it('a server refusal shows its message and resets the single-use token; a thrown call shows the generic message', async () => {
		const refused = makePort({ token: 'tok' });
		expect(await submitContact(refused.port, { send: async () => ({ success: false, message: 'Spam suspected.' }) }, fields)).toEqual({ ok: false, reason: 'server' });
		expect(refused.s.message).toBe('Spam suspected.');
		expect(refused.s.resets).toBe(1);
		expect(refused.s.token).toBe('');
		const thrown = makePort({ token: 'tok' });
		expect(await submitContact(thrown.port, { send: async () => { throw new Error('x'); } }, fields)).toEqual({ ok: false, reason: 'server' });
		expect(thrown.s.message).toBe('Failed to send message. Please try again.');
		const noMessage = makePort({ token: 'tok' });
		await submitContact(noMessage.port, { send: async () => ({ success: false }) }, fields);
		expect(noMessage.s.message).toBe('Something went wrong.');
	});

	it('double submit through the dispatcher makes one request', async () => {
		const { port } = makePort({ token: 'tok' });
		const ctl: ActionCtl = { disposed: false, admitted: [] };
		let sends = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const deps = { send: async () => { sends++; await gate; return { success: true }; } };
		const submit = () => dispatch(ctl, 'submit', ACTION_RESULTS as never, () => submitContact(port, deps, fields));
		const a = submit();
		const b = submit();
		expect(await b).toEqual({ ok: false, reason: 'busy' });
		release();
		expect(await a).toEqual({ ok: true });
		expect(sends).toBe(1);
	});
});
