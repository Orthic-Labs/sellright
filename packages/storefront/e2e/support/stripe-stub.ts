/**
 * Browser-side Stripe.js seam (A6). Stripe.js is fetched by `@stripe/stripe-js`'s `loadStripe` from a URL that depends
 * on the INSTALLED SDK's release train: `/v3` (4.x), `/dahlia/stripe.js` (9.x), `/endive/stripe.js` (10.x), each with
 * or without `?advancedFraudSignals=false`. The stub is therefore registered with the SDK's own recognition rule
 * (STRIPE_JS_URL_REGEX in the SDK's dist/index.mjs), not a literal URL, and `installStripeStub` proves the request
 * that reached it. It must be registered AFTER blockExternal: the later page.route matches first (fixtures.ts).
 *
 * The fake exposes the whole surface the Rotten checkout uses (components/payment/StripePaymentElement.tsx there):
 *   stripe.elements({mode,amount,currency,appearance}) · elements.create('payment',{layout}) -> mount / on('ready'|
 *   'loaderror'|'change') / destroy · elements.submit() · stripe.confirmPayment({elements, clientSecret, confirmParams})
 * and the surface of the base component (elements({clientSecret}), confirmPayment({elements, confirmParams})): each
 * Elements instance is bound to its clientSecret and confirmPayment resolves the intent through the supplied instance.
 * Every call is recorded on window.__stripeCalls. confirmPayment settles or declines the mock's PaymentIntent
 * (a same-origin POST that installStripeStub forwards to <mock>/control/stripe/confirm, relaying its status) and then resolves like Stripe.js.
 *
 * Steering from a spec (all page-side globals, set via page.evaluate / addInitScript):
 *   __STRIPE_OUTCOME      'succeeded' (default) | 'declined'
 *   __STRIPE_LOADERROR    message -> mounting a payment element fires 'loaderror' ({ error: { message } }) instead of 'ready'
 *   __STRIPE_SUBMIT_ERROR message -> elements.submit() resolves { error }
 *   __stripeEmit(event, payload)  fire a registered element handler, e.g. ('change', { complete: true })
 *   __STRIPE_WALLETS      e.g. { applePay: true } -> the express checkout element's 'ready' reports these wallets
 *                         available (unset: none, as on a device/domain without Apple Pay or Google Pay)
 *   __stripeEmitFor(type, event, payload)  fire a handler of the element of that type (e.g. 'expressCheckout');
 *                         resolves with the handlers' (awaited) results
 * elements.update(opts) is recorded as { fn: 'elements.update', opts } (express checkout's amount follows server quotes).
 */
import type { Page, Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MOCK_URL } from './env.mjs';

/** Matches every URL the three SDK release trains load Stripe.js from (see header). */
export const STRIPE_JS_URL_PATTERN = /^https:\/\/js\.stripe\.com\/(v3\/?|(v3|[a-z]+)\/stripe\.js)(\?.*)?$/;

/** Same-origin path the stub POSTs the confirm outcome to; installStripeStub forwards it to the mock gateway. */
export const STRIPE_CONFIRM_PATH = '/__e2e/stripe-confirm';

/** The script the stub serves. */
export function stripeStubScript(): string {
	return `(() => {
	const calls = (window.__stripeCalls = []);
	const byType = {};
	window.__stripeEmitFor = (type, event, payload) => Promise.all(((byType[type] || {})[event] || []).map((f) => f(payload)));
	const CONFIRM_PATH = ${JSON.stringify(STRIPE_CONFIRM_PATH)};
	function Stripe(key, options) {
		calls.push({ fn: 'Stripe', key, options: options ?? null });
		return {
			elements(opts) {
				calls.push({ fn: 'elements', opts: opts ?? null });
				const bound = (opts && opts.clientSecret) || null;
				const elementsInstance = {
					__clientSecret: bound,
					create(type, o) {
						calls.push({ fn: 'elements.create', type, options: o ?? null });
						const handlers = (byType[type] = {});
						const element = {
							mount(target) {
								calls.push({ fn: 'mount', target: String(target) });
								setTimeout(() => {
									if (window.__STRIPE_LOADERROR) (handlers.loaderror || []).forEach((f) => f({ elementType: 'payment', error: { type: 'api_connection_error', message: String(window.__STRIPE_LOADERROR) } }));
									else (handlers.ready || []).forEach((f) => f(type === 'expressCheckout'
										? { elementType: 'expressCheckout', availablePaymentMethods: window.__STRIPE_WALLETS
											? Object.assign({ applePay: false, googlePay: false, link: false, paypal: false, amazonPay: false, klarna: false }, window.__STRIPE_WALLETS)
											: undefined }
										: {}));
								}, 0);
							},
							on(event, cb) { (handlers[event] ||= []).push(cb); },
							destroy() { calls.push({ fn: 'destroy' }); },
						};
						if (type !== 'expressCheckout') window.__stripeEmit = (event, payload) => (handlers[event] || []).forEach((f) => f(payload));
						return element;
					},
					update(o) {
						calls.push({ fn: 'elements.update', opts: o ?? null });
					},
					submit() {
						calls.push({ fn: 'elements.submit' });
						return Promise.resolve(window.__STRIPE_SUBMIT_ERROR ? { error: { message: window.__STRIPE_SUBMIT_ERROR } } : {});
					},
				};
				return elementsInstance;
			},
			async confirmPayment(args) {
				// Like Stripe.js: the intent comes from the Elements instance (elements({clientSecret})) unless passed explicitly.
				const secret = String(args.clientSecret || (args.elements && args.elements.__clientSecret) || '');
				calls.push({ fn: 'confirmPayment', clientSecret: secret, hasElements: !!args.elements, confirmParams: args.confirmParams ?? null, redirect: args.redirect ?? null });
				const id = secret.split('_secret_')[0];
				// An unbound confirm is an invalid Stripe.js request: fail it (never report success for an intent we cannot name).
				if (!id) return { error: { type: 'invalid_request_error', code: 'parameter_missing', message: 'stub: confirmPayment without a client secret' } };
				const outcome = window.__STRIPE_OUTCOME || 'succeeded';
				// Same-origin (the storefront's CSP connect-src forbids the mock's origin); installStripeStub forwards it to the mock
				// and relays the mock's real status, so a refused confirm is an error here instead of a silent success.
				const res = await fetch(CONFIRM_PATH, { method: 'POST', body: JSON.stringify({ id, outcome }) });
				if (!res.ok) return { error: { type: 'api_error', message: 'stub: confirm refused by the mock gateway (' + res.status + ')' } };
				return outcome === 'succeeded'
					? { paymentIntent: { id, status: 'succeeded' } }
					: { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } };
			},
		};
	}
	Stripe.version = 3;
	window.Stripe = Stripe;
})();`;
}

export interface StripeStubHandle {
	/** URLs requested from js.stripe.com that matched the pattern and were fulfilled by the stub. */
	fulfilled: string[];
	/** Every request URL to js.stripe.com, matched or not. */
	requested: string[];
	/** js.stripe.com requests that failed (an aborted/blocked miss would otherwise hide silently). */
	failed: string[];
	/** Throws unless a request was fulfilled by the stub, nothing to js.stripe.com failed, and (when given) the observed URL starts with the installed SDK's script URL. */
	assertReached(sdkScriptUrl?: string): void;
	calls(): Promise<Array<Record<string, unknown>>>;
}

export async function installStripeStub(page: Page, mockUrl = MOCK_URL): Promise<StripeStubHandle> {
	const handle: StripeStubHandle = {
		fulfilled: [], requested: [], failed: [],
		assertReached(sdkScriptUrl) {
			if (handle.failed.length) throw new Error(`js.stripe.com request(s) failed (pattern miss or abort): ${handle.failed.join(', ')}`);
			if (!handle.fulfilled.length) throw new Error(`no request reached the Stripe.js stub; js.stripe.com requests seen: ${JSON.stringify(handle.requested)}`);
			if (sdkScriptUrl && !handle.fulfilled.some((u) => u.startsWith(sdkScriptUrl))) {
				throw new Error(`stub served ${JSON.stringify(handle.fulfilled)} but the installed SDK loads ${sdkScriptUrl} — release-train URL changed?`);
			}
		},
		calls: () => page.evaluate(() => (window as unknown as { __stripeCalls?: Array<Record<string, unknown>> }).__stripeCalls ?? []),
	};
	page.on('request', (r: Request) => { if (new URL(r.url()).hostname === 'js.stripe.com') handle.requested.push(r.url()); });
	page.on('requestfailed', (r: Request) => { if (new URL(r.url()).hostname === 'js.stripe.com') handle.failed.push(r.url()); });
	await page.route((url) => STRIPE_JS_URL_PATTERN.test(url.href), (route) => {
		handle.fulfilled.push(route.request().url());
		return route.fulfill({ status: 200, contentType: 'text/javascript', body: stripeStubScript() });
	});
	await page.route((url) => url.pathname === STRIPE_CONFIRM_PATH, async (route) => {
		const res = await fetch(`${mockUrl}/control/stripe/confirm`, { method: 'POST', body: route.request().postData() ?? '' });
		await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
	});
	return handle;
}

/**
 * The script URL the SDK in `sdkEntry` (node_modules/@stripe/stripe-js/dist/index.mjs) will request, read from its source.
 * Newer SDKs build it from a release-train constant (`var RELEASE_TRAIN = 'endive'` -> /endive/stripe.js; it is NOT a
 * string literal there), older ones carry the literal `https://js.stripe.com/v3`.
 */
export function installedSdkScriptUrl(sdkEntry: string): string {
	const src = readFileSync(sdkEntry, 'utf8');
	const train = /var\s+RELEASE_TRAIN\s*=\s*['"]([a-z0-9]+)['"]/.exec(src)?.[1];
	if (train) return `https://js.stripe.com/${train}/stripe.js`;
	const literal = /var\s+STRIPE_JS_URL\s*=\s*['"](https:\/\/js\.stripe\.com\/[^'"]+)['"]/.exec(src)?.[1];
	if (literal) return literal;
	throw new Error(`could not read the Stripe.js URL from ${sdkEntry} (SDK layout changed)`);
}
