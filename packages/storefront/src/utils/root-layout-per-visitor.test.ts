// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0001 §1 (I-2): the root layout renders nothing per visitor. Its loaders must not read the session, the country
 * cookie or set the legacy-cart hint; those come from GET /api/session/ and document.cookie in the browser. The preview
 * token is the one per-visitor input left, and it vetoes the edge cache whether it came by query or by cookie.
 */
const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../routes/layout.tsx'), 'utf8');

describe('root layout carries no per-visitor data (ADR-0001 I-2)', () => {
	it('has no auth loader and no session read during SSR', () => {
		expect(src).not.toMatch(/useAuthLoader/);
		expect(src).not.toMatch(/bootstrapCustomer|AUTH_TOKEN|__vendure_session/);
	});

	it('reads the countryCode cookie only in the browser and sets no legacy-cart cookie', () => {
		expect(src).not.toMatch(/cookie\.get\(COUNTRY_COOKIE\)/);
		expect(src).toMatch(/getCookie\(COUNTRY_COOKIE\)/);
		expect(src).not.toMatch(/cookie\.set\('sr_legacy_cart'/);
	});

	it('only reads cookies in the identity loader, for the preview token, and vetoes the edge cache for it', () => {
		const reads = [...src.matchAll(/cookie\.(get|set)\(([^,)]+)/g)].map((m) => m[2]);
		expect(reads.every((name) => name === 'PREVIEW_TOKEN_COOKIE')).toBe(true);
		expect(src).toMatch(/if \(previewToken && !queryToken\) vetoEdgeCache\(headers, 'preview'\)/);
	});

	it('starts signed out and fills the customer from the browser session read', () => {
		expect(src).toMatch(/customer: anonymousCustomer\(\) as ActiveCustomer/);
		expect(src).toMatch(/fetchSessionCustomer\(\)/);
	});
});
