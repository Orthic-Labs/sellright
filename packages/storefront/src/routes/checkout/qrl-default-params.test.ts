// @vitest-environment node
/**
 * Regression for review round 8. `ensureShopConfig = $(async (gen = paymentInit.gen) => …)` was compiled so that the
 * default (which reads captured state) was not applied: `gen` arrived as undefined, so every `isCurrentView(paymentInit,
 * gen)` check failed, the shop config was never applied and the payment methods / changed-total notice never rendered
 * (e2e money-sezzle, money-checkout #3). Observed in the browser: `DBG stale undefined now 0`.
 * A QRL parameter default must never read captured state; resolve it inside the body.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bumpView, isCurrentView } from '~/components/checkout/view-generation';

const route = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');

describe('checkout route QRL parameter defaults', () => {
	it('an undefined generation is never current', () => {
		const view = { gen: 0 };
		expect(isCurrentView(view, undefined as unknown as number)).toBe(false);
		expect(isCurrentView(view, bumpView(view))).toBe(true);
	});

	it('no $() handler in the route defaults a parameter from the paymentInit store', () => {
		expect(route).not.toMatch(/\$\(async \([^)]*=\s*paymentInit\./);
	});

	it('ensureShopConfig resolves its generation inside the body', () => {
		expect(route).toMatch(/const ensureShopConfig = \$\(async \(genArg\?: number\)[^{]*\{\s*const gen = genArg \?\? paymentInit\.gen;/);
	});
});
