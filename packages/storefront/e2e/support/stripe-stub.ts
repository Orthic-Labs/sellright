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
 * and the surface of the base component (elements({clientSecret}), confirmPayment({elements, confirmParams})).
 * Every call is recorded on window.__stripeCalls. confirmPayment settles or declines the mock's PaymentIntent
 * (POST <mock>/control/stripe/confirm, a no-cors text/plain request so no preflight) and then resolves like Stripe.js.
 *
 * Steering from a spec (all page-side globals, set via page.evaluate / addInitScript):
 *   __STRIPE_OUTCOME      'succeeded' (default) | 'declined'
 *   __STRIPE_SUBMIT_ERROR message -> elements.submit() resolves { error }
 *   __stripeEmit(event, payload)  fire a registered element handler, e.g. ('change', { complete: true })
 */
import type { Page, Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MOCK_URL } from './env.mjs';

/** Matches every URL the three SDK release trains load Stripe.js from (see header). */
export const STRIPE_JS_URL_PATTERN = /^https:\/\/js\.stripe\.com\/(v3\/?|(v3|[a-z]+)\/stripe\.js)(\?.*)?$/;

/** The script the stub serves. `mockUrl` is where the page may POST the confirm outcome (loopback is not blocked). */
export function stripeStubScript(mockUrl = MOCK_URL): string {
	return `(() => {
	const calls = (window.__stripeCalls = []);
	const MOCK = ${JSON.stringify(mockUrl)};
	function Stripe(key, options) {
		calls.push({ fn: 'Stripe', key, options: options ?? null });
		return {
			elements(opts) {
				calls.push({ fn: 'elements', opts: opts ?? null });
				return {
					create(type, o) {
						calls.push({ fn: 'elements.create', type, options: o ?? null });
						const handlers = {};
						const element = {
							mount(target) {
								calls.push({ fn: 'mount', target: String(target) });
								setTimeout(() => (handlers.ready || []).forEach((f) => f({})), 0);
							},
							on(event, cb) { (handlers[event] ||= []).push(cb); },
							destroy() { calls.push({ fn: 'destroy' }); },
						};
						window.__stripeEmit = (event, payload) => (handlers[event] || []).forEach((f) => f(payload));
						return element;
					},
					submit() {
						calls.push({ fn: 'elements.submit' });
						return Promise.resolve(window.__STRIPE_SUBMIT_ERROR ? { error: { message: window.__STRIPE_SUBMIT_ERROR } } : {});
					},
				};
			},
			async confirmPayment(args) {
				const secret = String(args.clientSecret || '');
				calls.push({ fn: 'confirmPayment', clientSecret: secret, hasElements: !!args.elements, confirmParams: args.confirmParams ?? null, redirect: args.redirect ?? null });
				const id = secret.split('_secret_')[0];
				const outcome = window.__STRIPE_OUTCOME || 'succeeded';
				await fetch(MOCK + '/control/stripe/confirm', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ id, outcome }) });
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
		return route.fulfill({ status: 200, contentType: 'text/javascript', body: stripeStubScript(mockUrl) });
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
