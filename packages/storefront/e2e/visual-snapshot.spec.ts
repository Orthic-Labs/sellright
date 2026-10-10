import { test } from './fixtures';
import { CATALOG } from './support/global-setup';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Full-page screenshots of the key routes at two widths, written to E2E_VISUAL_DIR. Not an assertion suite:
 * the orchestrator compares two runs (before/after a structural change) byte by byte, and the owner reviews
 * the images for a brand cutover. Opt-in: without E2E_VISUAL_DIR it does not run (missing coverage, not a pass).
 */
const OUT = process.env.E2E_VISUAL_DIR ?? '';
test.skip(!OUT, 'visual-snapshot needs E2E_VISUAL_DIR: did not run');

const WIDTHS = [1440, 390] as const;
const routes = (): [string, string][] => [
	['home', '/'],
	['shop', '/shop/'],
	['pdp', `/products/${CATALOG[2]!.slug}/`],
	['checkout-empty', '/checkout/'],
	['sign-in', '/sign-in/'],
	['about', '/about/'],
	['blog', '/blog/'],
	['contact', '/contact/'],
	['not-found', '/this-route-does-not-exist/'],
];

for (const width of WIDTHS) {
	test(`visual snapshots at ${width}px`, async ({ page }) => {
		test.setTimeout(180_000);
		mkdirSync(OUT, { recursive: true });
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		for (const [name, path] of routes()) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			await page.evaluate(() => document.fonts.ready);
			// a strict-CSP page (the 404 document) refuses an injected style tag; reduced motion still applies there
			await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => undefined);
			await page.waitForTimeout(300);
			await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: true });
		}
	});
}
