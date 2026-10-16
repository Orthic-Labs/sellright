// @vitest-environment node
/**
 * Static guards for the LOCKED stock architecture (CLAUDE.md "Stock Architecture"): the rules that can be checked by
 * reading source, run on every `pnpm test`. They complement the behavioural suite (e2e/stock-parity.spec.ts), which
 * observes API-side requests. Observation only — nothing here changes how stock is fetched. Plan A9 scenarios 12, 14, 17.
 * Comments are stripped before matching, so prose that names a forbidden thing ("no cache, no TTL") never trips a guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), 'utf8'));

function sourceFiles(dir = SRC, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !full.includes(`${join('src', 'generated')}`)) out.push(full);
	}
	return out;
}
/**
 * Slice `source` from `from` to the first `to` AFTER it (end of file when omitted). Fails loudly when a marker is
 * missing, the end precedes the start or the slice is empty — an `indexOf` of -1, or an end found earlier in the file
 * (an import), would otherwise slice an empty/wrong string and let an assertion pass or fail vacuously.
 */
const section = (source: string, from: string, to?: string): string => {
	const start = source.indexOf(from);
	expect(start, `start marker not found: ${from}`).toBeGreaterThan(-1);
	const end = to === undefined ? source.length : source.indexOf(to, start + from.length);
	expect(end, `end marker not found after the start: ${to}`).toBeGreaterThan(start);
	const body = source.slice(start, end);
	expect(body.length, `empty section: ${from}`).toBeGreaterThan(from.length);
	return body;
};
const all = sourceFiles().map((f) => ({ rel: relative(SRC, f), code: stripComments(readFileSync(f, 'utf8')) }));

describe('locked stock rules — static guards (scenario 14)', () => {
	it('ProductCacheService has no stock method or field', () => {
		expect(read('services/ProductCacheService.ts')).not.toMatch(/stock/i);
	});
	it('no STOCK_CACHE_DURATION and no lastStockRefresh anywhere in src', () => {
		const hits = all.filter((f) => /STOCK_CACHE_DURATION|lastStockRefresh/.test(f.code)).map((f) => f.rel);
		expect(hits).toEqual([]);
	});
});

describe('no focus / visibility stock refresh (scenario 12)', () => {
	it('no visibilitychange handler and no focus handler registered anywhere in src', () => {
		const hits = all
			.filter((f) => /visibilitychange|use(?:On)?(?:Document|Window)\(\s*['"](?:focus|visibilitychange)['"]|addEventListener\(\s*['"]focus['"]/.test(f.code))
			.map((f) => f.rel);
		expect(hits).toEqual([]);
	});
});

describe('catalog reader holds no cache (scenario 17 structural guard)', () => {
	// A cache keyed on the generation is still a stock cache (locked layer 5): the publisher mints a new generation per
	// publication, so a generation-keyed memo looks fresh after every publish — only the no-publication reload shows it.
	for (const file of ['services/catalog-snapshot.ts', 'services/browse-catalog.ts']) {
		describe(file, () => {
			const code = read(file);
			it('has no module-scope let/var', () => {
				expect(code.match(/^(let|var)\s/gm) ?? []).toEqual([]);
			});
			it('has no module-scope const other than a function, import-free of mutable containers', () => {
				const offenders = (code.match(/^(?:export\s+)?const\s+\w+[^=\n]*=\s*(?!async\b|function\b|\([^)]*\)\s*=>|\w+\s*=>).*$/gm) ?? []);
				expect(offenders).toEqual([]);
			});
			it('constructs no Map/WeakMap/Set/WeakSet and holds no Promise at module scope', () => {
				expect(code).not.toMatch(/\bnew\s+(Map|WeakMap|Set|WeakSet)\b/);
				expect(code.match(/^(?:export\s+)?(?:const|let|var)\s+\w+[^=\n]*=\s*(?:Promise\.|new Promise)/gm) ?? []).toEqual([]);
			});
			it('imports no cache/memo helper and names none', () => {
				expect(code).not.toMatch(/import[^;]*from\s+['"][^'"]*(cache|memo|lru)[^'"]*['"]/i);
				expect(code).not.toMatch(/\b(memoize|memo|lru|cache)\b/i);
			});
		});
	}
});

describe('pre-submit live stock read (locked layer 4)', () => {
	it('placeOrder awaits refreshStockBeforeSubmit before the order-creating call, both inside one cart lock', () => {
		const code = read('hooks/useCheckout.ts');
		const lock = code.indexOf('CartService.withLock(');
		const read_ = code.indexOf('await refreshStockBeforeSubmit(scope)');
		const post = code.indexOf('srPlaceOrder(form, snapshot, scope)');
		expect(lock, 'the live read and the order POST must share one CartService.withLock').toBeGreaterThan(-1);
		expect(read_, 'refreshStockBeforeSubmit must be awaited in placeOrder').toBeGreaterThan(lock);
		expect(post).toBeGreaterThan(read_);
	});

	it('the validated read is passed into the order call, and checkout.ts makes no second cart read or tokenless submit', () => {
		const hook = read('hooks/useCheckout.ts');
		expect(hook).toMatch(/const snapshot = await refreshStockBeforeSubmit\(scope\)/);
		expect(hook).toMatch(/srPlaceOrder\(form, snapshot, scope\)/);
		const provider = read('providers/shop/checkout/checkout.ts');
		expect(provider).not.toMatch(/checkoutSnapshot|readFresh|CartService\.refresh/);
		expect(provider).not.toMatch(/if \(cart\)/);
	});

	it('resuming a converted cart reads no cart, validates no stock and POSTs no order', () => {
		const hook = read('hooks/useCheckout.ts');
		const resume = section(hook, 'const resumeConverted');
		expect(resume).not.toMatch(/refreshStockBeforeSubmit|srPlaceOrder|readFresh|CartService\.refresh|validateStock/);
		expect(resume).toMatch(/CartService\.lookupConvertedCheckout\(/);
	});
	it('checkout entry reads the live cart first and a failed read never reaches the normal checkout', () => {
		const route = read('routes/checkout/index.tsx');
		const entry = section(route, 'const enterCheckout', 'const onResumeRetry$');
		expect(entry.indexOf('await refreshCartLive(localCart)')).toBeGreaterThan(-1);
		expect(entry).toMatch(/decideCheckoutEntry\(/);
		// The only path to the normal checkout is behind the decision; a probe/resume decision returns before it.
		expect(entry.indexOf('await beginResume(')).toBeLessThan(entry.indexOf('await loadNormalCheckout(gen)'));
		expect(entry).not.toMatch(/refreshCartStock/);
		expect(route).toMatch(/readFailed: read === 'failed'/);
	});

	it('a conversion discovered after initialisation switches to resume through the shared predicate', () => {
		const route = read('routes/checkout/index.tsx');
		expect(route).toMatch(/shouldResumeLate\(/);
		expect(route).toMatch(/track\(\(\) => localCart\.cart\.status\)/);
	});

	it('the resume view classifies payment failures itself and never reuses the form-error handler', () => {
		const route = read('routes/checkout/index.tsx');
		const handler = section(route, 'const onPaymentError$');
		expect(handler.indexOf("srState.resume !== 'none'")).toBeGreaterThan(-1);
		expect(handler.indexOf('recoverResumePaymentError')).toBeLessThan(handler.indexOf('recoverCheckoutPaymentError'));
		expect(route).toMatch(/classifyResumePaymentError\(/);
	});

	it('leaving a resume state for a normal cart clears ALL previous-order payment state', () => {
		const route = read('routes/checkout/index.tsx');
		const entry = section(route, 'const enterCheckout', 'const onResumeRetry$');
		// The normal path resets before the form initialises (no bare `resume = 'none'`).
		expect(entry.indexOf('await resetOrderState()')).toBeGreaterThan(-1);
		expect(entry.indexOf('await resetOrderState()')).toBeLessThan(entry.indexOf('await loadNormalCheckout(gen)'));
		expect(entry).not.toMatch(/srState\.resume = 'none'/);
		const reset = section(route, 'const resetOrderState', 'const resumeQueue');
		for (const field of ['resetOrder()', 'stripeConfirmTrigger.value = 0', 'gatewayConfirmTrigger.value = 0', 'totalConfirmed.value = false', 'paymentInit.failed = false']) {
			expect(reset).toContain(field);
		}
		// "Start a new cart" uses the same reset instead of clearing a subset.
		const startNew = section(route, 'const onStartNewCart$', 'useVisibleTask$');
		expect(startNew).toContain('await resetOrderState()');
		const hook = read('hooks/useCheckout.ts');
		expect(hook).toMatch(/const resetOrder = \$\(/);
		// A new resume lookup starts from an empty order (a cancelled/unknown outcome must not keep the old 'paying').
		const resume = section(hook, 'const resumeConverted');
		expect(resume.indexOf('EMPTY_ORDER_STATE')).toBeGreaterThan(-1);
		expect(resume.indexOf('EMPTY_ORDER_STATE')).toBeLessThan(resume.indexOf('lookupConvertedCheckout'));
	});

	it('an existing order whose PLACE ORDER failed is recovered through resume, not left behind the form gates', () => {
		const route = read('routes/checkout/index.tsx');
		const place = read('components/checkout/place-order-flow.ts');
		const recover = section(place, 'shouldRecoverExistingOrder(', 'await deps.beginResume()');
		expect(recover).toMatch(/orderCode: srState\.code/);
		// the recovery precedes the generic "throw the error" exit
		expect(place.indexOf('shouldRecoverExistingOrder(')).toBeLessThan(place.indexOf("throw new Error(srState.error ||"));
		// and the late predicate is given the phase so a failed initialisation is not mistaken for a working view
		expect(section(route, 'shouldResumeLate(', '{\n')).toMatch(/phase: srState\.phase/);
	});

	it('zero-due settlement is only announced as paid on proof', () => {
		const hook = read('hooks/useCheckout.ts');
		expect(hook).toMatch(/!\(await settleZeroDue\(created\.code/);
		expect(hook).toMatch(/const proven = await settleZeroDue\(order\.code, order\.receiptToken\);[\s\S]*?if \(!proven\)/);
		expect(read('hooks/zero-due.ts')).toMatch(/classifyOrderState\(order\.state\) === 'settled'/);
	});

	it('every read of the shop config awaits its initialisation', () => {
		const route = read('routes/checkout/index.tsx');
		expect(route).not.toMatch(/shopConfig\.value;?\s*\n\s*const anyGatewayConfigured/);
		expect(route).not.toMatch(/\.then\(\(cfg\) => applyShopConfig/);
		expect(route).toMatch(/await applyShopConfig\(cfg\)/);
		const resume = read('components/checkout/resume-flow.ts');
		expect(resume).toContain('await deps.ensureShopConfig(gen)');
		const place = read('components/checkout/place-order-flow.ts');
		expect(place.indexOf('await deps.ensureShopConfig()')).toBeGreaterThan(-1);
		expect(place.indexOf('await deps.ensureShopConfig()')).toBeLessThan(place.indexOf('deps.placeOrder('));
		// The default method is applied once.
		expect(route).toMatch(/shouldApplyConfigDefault\(configDefaultApplied\.value\)/);
	});

	it('payment-component initialisation failures have a retry in both panels', () => {
		const route = read('routes/checkout/index.tsx');
		expect(route).toMatch(/const onPaymentInitError\$/);
		for (const rel of ['components/checkout/CheckoutPaymentPanel.tsx', 'components/checkout/CheckoutResumePanel.tsx']) {
			const panel = read(rel);
			expect(panel).toContain('<PaymentInitRetry');
			expect(panel).toMatch(/onInitError\$=\{props\.onPaymentInitError\$\}/);
			expect(panel).toMatch(/key=\{props\.paymentInit\.key\}/);
		}
		const retry = read('components/checkout/PaymentInitRetry.tsx');
		expect(retry).toMatch(/props\.init\.failed = false/);
		expect(retry).toMatch(/props\.init\.key = props\.init\.key \+ 1/);
		// Components report load failures through onInitError$ (falling back to onError$), confirm failures through onError$.
		const stripe = read('components/checkout/StripePaymentElement.tsx');
		const nmi = read('components/payment/NMI.tsx');
		expect(stripe).toMatch(/await \(props\.onInitError\$ \?\? props\.onError\$\)\(message, mountGen\.value\)/);
		expect(stripe).toMatch(/reportInitError\('Stripe failed to load\.'\)/);
		// Asynchronous hosted-field failures use the same path: Stripe `loaderror`, NMI init timeout (no pending tokenization).
		expect(stripe).toMatch(/on\('loaderror'[\s\S]*?reportInitError\(/);
		expect(stripe).toMatch(/on\('ready', \(\) => \{ if \(!disposed\.value\) ready\.value = true; \}\)/);
		expect(nmi).toMatch(/await \(props\.onInitError\$ \?\? props\.onError\$\)\(message, mountGen\.value\)/);
		expect(nmi).toMatch(/reportInitError\(e instanceof Error \? e\.message : 'Card payment failed to load\.'\)/);
	});

	it('payment components ignore every async callback after unmount (disposed flag set in cleanup)', () => {
		for (const rel of ['components/checkout/StripePaymentElement.tsx', 'components/payment/NMI.tsx']) {
			const code = read(rel);
			expect(code, rel).toMatch(/cleanup\(\(\) => \{[\s\S]*?disposed\.value = true/);
			// Nothing reaches the shared init-error callback except through the guarded reporter.
			const reporter = section(code, 'const reportInitError', '};');
			expect(reporter, rel).toMatch(/if \(disposed\.value\) return;/);
			expect(code.replace(reporter, ''), rel).not.toMatch(/props\.onInitError\$/);
			// A load that resolves after unmount stops before creating/configuring anything.
			expect(code, rel).toMatch(/await (loadStripe|loadCollectJs)\([^\n]*\n\s*if \(disposed\.value\) return;/);
		}
		const nmi = read('components/payment/NMI.tsx');
		expect(nmi).toMatch(/if \(!disposed\.value\) await props\.onProcessingChange\$\?\.\(false, mountGen\.value\)/);
		expect(nmi).toMatch(/if \(!disposed\.value\) ready\.value = true/);
	});

	it('resume payment recovery keeps controls locked until the order status is read and applies only a current result', () => {
		const route = read('routes/checkout/index.tsx');
		const recovery = section(route, 'const recoverResumePaymentError = $(', 'const onPaymentError$');
		expect(recovery.indexOf('state.loading = true')).toBeGreaterThan(-1);
		expect(recovery.indexOf('state.loading = true')).toBeLessThan(recovery.indexOf('await classifyResumePaymentError'));
		expect(recovery).toMatch(/await classifyResumePaymentError[\s\S]*if \(!current\(\)\) return;/);
		// The lock is released in `finally`, whatever happened — an unexpected failure enters the retryable error view.
		expect(recovery).toMatch(/\} finally \{\s*state\.loading = false;/);
		expect(recovery).toMatch(/catch \(e\) \{[\s\S]*srState\.resume = 'error'/);
		// A recovery does not bump: the mounted component stays in charge after a decline.
		expect(recovery).not.toMatch(/bumpView/);
	});

	it('ONE view generation: bumped on method switch, resume start, retry, start-new-cart and leaving the page; no second counter', () => {
		const route = read('routes/checkout/index.tsx');
		expect(route).not.toMatch(/resumeGen/);
		expect(read('components/checkout/resume-flow.ts')).toMatch(/const gen = bumpView\(deps\.view\)/);
		expect(section(route, 'const onResumeRetry$', 'const onResumeMethod$')).toMatch(/const gen = bumpView\(paymentInit\)/);
		expect(section(route, 'const onStartNewCart$', 'useVisibleTask$')).toMatch(/const gen = bumpView\(paymentInit\)/);
		// leaving the page bumps the generation AND voids any queued method selection, in one call
		expect(route).toMatch(/cleanup\(\(\) => \{ cancelResumeFlow\(paymentInit, resumeQueue\); \}\)/);
		expect(read('components/checkout/resume-flow.ts')).toMatch(/export const cancelResumeFlow[\s\S]*?bumpView\(view\);\s*cancelResumes\(queue\)/);
		// The leave-page bump lives in its own task that reads nothing reactive; a task that subscribes to page state
		// (entry, late resume) re-runs when the cart converts at order creation and would bump through its cleanup.
		const leaveTask = section(route, 'useVisibleTask$(({ cleanup })', 'useVisibleTask$(async () =>');
		expect(leaveTask).not.toMatch(/track\(|\.value|localCart|paymentInit\.gen/);
		expect(section(route, 'useVisibleTask$(async () =>', 'useVisibleTask$(async ({ track })')).not.toMatch(/cleanup/);
		expect(section(route, 'useVisibleTask$(async ({ track })', 'useTask$(async ({ track })')).not.toMatch(/cleanup|bumpView/);
		expect(section(route, 'const placeOrder = $(', 'const onPaymentError$')).not.toMatch(/bumpView/);
		for (const rel of ['components/checkout/CheckoutPaymentPanel.tsx', 'components/checkout/CheckoutResumePanel.tsx']) {
			expect(read(rel), rel).toMatch(/props\.paymentMethod\.value = m;\s*bumpView\(props\.paymentInit\)/);
		}
		expect(read('components/checkout/PaymentInitRetry.tsx')).toMatch(/bumpView\(props\.init\)/);
	});

	it('every async handler in the route captures the generation at entry and checks it after its awaits', () => {
		const route = read('routes/checkout/index.tsx');
		// enterCheckout: after the cart load, the live read, the reset and the config read — before the form initialises.
		const entry = section(route, 'const enterCheckout = $(', 'const onResumeRetry$');
		expect(entry).toMatch(/const gen = paymentInit\.gen/);
		expect((entry.match(/if \(!current\(\)\) return;/g) ?? []).length).toBeGreaterThanOrEqual(4);
		expect(entry).toMatch(/loadNormalCheckout\(gen\)/);
		// loadNormalCheckout: after every await that precedes a state write.
		const normal = section(route, 'const loadNormalCheckout = $(async (gen: number)', 'const enterCheckout');
		expect((normal.match(/if \(!isCurrentView\(paymentInit, gen\)\) return;/g) ?? []).length).toBeGreaterThanOrEqual(3);
		// config load: a stale read writes nothing.
		const config = section(route, 'const ensureShopConfig = $(', 'const resetOrderState');
		expect(config).toMatch(/await getShopConfig\(\);\s*if \(!isCurrentView\(paymentInit, gen\)\) return cfg;\s*await applyShopConfig/);
		// beginResume: after the config read, before payment initialisation; it passes the check into resumeConverted and
		// navigates only while current.
		const resume = read('components/checkout/resume-flow.ts');
		expect(resume).toMatch(/await deps\.ensureShopConfig\(gen\)/);
		expect(resume).toMatch(/deps\.resumeConverted\(token, [^\n]*, probe, current\)/);
		expect(resume).toMatch(/view === 'settled' && current\(\)/);
		expect(resume).toMatch(/catch \(e\) \{\s*if \(!current\(\)\) return;/);
		// placeOrder: after the config read and the order request, in the catch, and flags released in finally.
		const flow = read('components/checkout/place-order-flow.ts');
		expect(flow).toMatch(/await deps\.ensureShopConfig\(\);[\s\S]*?if \(!current\(\)\) return;[\s\S]*?const anyGatewayConfigured/);
		expect(flow).toMatch(/await deps\.placeOrder\([^\n]*\n[\s\S]*?if \(!current\(\)\) return;\s*if \(srState\.convertedCart\)/);
		const place = section(route, 'const placeOrder = $(', 'const recoverResumePaymentError');
		expect(place).toMatch(/await submitOrderFlow\(/);
		expect(place).toMatch(/catch \(error\) \{\s*if \(!current\(\)\) return;/);
		expect(place).toMatch(/\} finally \{\s*showProcessingModal\.value = false;\s*isOrderProcessing\.value = false;/);
		// start-new-cart: after the retire lookup and the reset.
		const startNew = section(route, 'const onStartNewCart$', 'useVisibleTask$');
		expect((startNew.match(/if \(!isCurrentView\(paymentInit, gen\)\) return;/g) ?? []).length).toBe(2);
		// retry: its catch does not write for a replaced view.
		expect(section(route, 'const onResumeRetry$', 'const onResumeMethod$')).toMatch(/catch \(error\) \{\s*if \(!isCurrentView\(paymentInit, gen\)\) return;/);
		// the initial entry task.
		expect(section(route, 'useVisibleTask$(async () =>', 'useVisibleTask$(async ({ track })')).toMatch(/if \(isCurrentView\(paymentInit, gen\)\) state\.error =/);
	});

	it('resumeConverted stops without writing state once superseded: after the lookup, the settle, the payment init and in its catch', () => {
		const resume = section(read('hooks/useCheckout.ts'), 'const resumeConverted');
		expect(resume).toMatch(/isCurrent: \(\) => boolean = \(\) => true/);
		expect(resume).toMatch(/await CartService\.lookupConvertedCheckout\(token\);\s*if \(!isCurrent\(\)\) return 'superseded';/);
		expect(resume).toMatch(/await settleZeroDue\([^\n]*\n\s*if \(!isCurrent\(\)\) return 'superseded';/);
		expect(resume).toMatch(/await initPayment\([^\n]*\n\s*if \(!isCurrent\(\)\) return 'superseded';\s*state\.clientSecret = clientSecret;/);
		expect(resume).toMatch(/catch \(error\) \{\s*if \(!isCurrent\(\)\) return 'superseded';/);
		// the loading flag it set is released in finally, whatever the outcome.
		expect(resume).toMatch(/\} finally \{\s*checkoutState\.isLoading = false;/);
	});

	it('payment-component callbacks carry the component\'s own mount id and the route rejects a stale one', () => {
		const route = read('routes/checkout/index.tsx');
		expect(section(route, 'const onPaymentError$ = $(', 'const onPaymentInitError$')).toMatch(/if \(!acceptsMount\(paymentInit, mountGen\)\) return;/);
		expect(section(route, 'const onPaymentInitError$ = $(', 'const onPaymentProcessingChange$')).toMatch(/if \(!applyPaymentInitError\([^\n]*mountGen\)\) return;/);
		expect(section(route, 'const onPaymentProcessingChange$ = $(', 'const onGatewaySuccess$')).toMatch(/applyPaymentProcessingChange\([^\n]*isProcessing, mountGen\)/);
		const callbacks = read('components/checkout/payment-callbacks.ts');
		expect(callbacks).toMatch(/if \(!acceptsMount\(deps\.view, mountGen\)\) return false;/);
		expect(callbacks).toMatch(/if \(isProcessing && !acceptsMount\(deps\.view, mountGen\)\) return false;/);
		for (const rel of ['components/checkout/StripePaymentElement.tsx', 'components/payment/NMI.tsx', 'components/payment/Sezzle.tsx']) {
			const code = read(rel);
			expect(code, rel).toMatch(/const mountGen = useSignal\(props\.mountGen\)/);
			// no callback is invoked without the mount id
			for (const call of code.match(/props\.on(Error|InitError|ProcessingChange)\$[^;]*;/g) ?? []) expect(call, `${rel}: ${call}`).toMatch(/mountGen\.value/);
		}
		for (const rel of ['components/checkout/CheckoutPaymentPanel.tsx', 'components/checkout/CheckoutResumePanel.tsx']) {
			expect(read(rel), rel).toMatch(/mountGen=\{props\.paymentInit\.gen\}/);
		}
	});

	it('every client read checkout uses treats an empty body as a failed read', () => {
		const provider = read('providers/shop/checkout/checkout.ts');
		for (const what of ["'order'", "'shop config'", "'shipping-methods'", "'payment-intent'", "'pay'"]) expect(provider).toContain(`nonEmpty(data, ${what})`);
		expect(provider).not.toMatch(/data \?\? \[\]|data\?\.methods/);
		const customer = read('services/customer.ts');
		expect(customer).toMatch(/Empty auth\/me response/);
		expect(customer).toMatch(/Empty addresses response/);
	});

	it('Stripe keeps the controls locked until the error handler has run, then releases them', () => {
		const code = read('components/checkout/StripePaymentElement.tsx');
		const body = section(code, 'if (error) {', 'return (');
		expect(body.indexOf('onError$(')).toBeGreaterThan(-1);
		expect(body.indexOf('onError$(')).toBeLessThan(body.indexOf('onProcessingChange$?.(false'));
		expect(body).toMatch(/finally/);
	});
});
