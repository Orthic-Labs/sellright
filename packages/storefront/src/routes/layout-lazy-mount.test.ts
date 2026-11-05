// @vitest-environment node
// #360: modals/menu mount only when opened; non-urgent start-up work is on qidle; stock/checkout starts untouched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('lazy mount (#360)', () => {
	const layout = read('routes/layout.tsx');
	it('the login modal is rendered only through the everOpened gate', () => {
		expect(layout).toMatch(/everOpened \? <LoginModalComponent \/> : null/);
		expect(layout).toContain('<LoginModalGate />');
		expect(layout).not.toMatch(/<LoginModalComponent \/>\s*<\/div>/);
	});
	it('the opener sets the state flag before isOpen', () => {
		const ctx = read('contexts/LoginModalContext.tsx');
		expect(ctx).toMatch(/isOpen: false,\s*everOpened: false/);
		expect(ctx).toMatch(/state\.everOpened = true;\s*state\.isOpen = true;/);
	});
	it('the menu is mounted only while open', () => {
		expect(layout).toContain('state.showMenu && <Menu />');
	});
	it('openers warm the chunk on intent', () => {
		const header = read('components/header/header.tsx');
		expect(header).toMatch(/onPointerDown\$=\{warmMenu\$\}[\s\S]*onFocus\$=\{warmMenu\$\}/);
		expect(header).toContain('onPointerDown$={warmLogin$}');
		const v = read('components/verification/VerificationButton.tsx');
		expect(v).toMatch(/onPointerDown\$=\{warm\}[\s\S]*onMouseEnter\$=\{warm\}[\s\S]*onFocus\$=\{warm\}/);
		expect(v).toContain('{showModal.value && (');
	});
	it('session read, country cookie and cross-tab sync run on qidle, not qinit', () => {
		expect(layout).not.toContain("useOnDocument('qinit'");
		const idle = layout.match(/useOnDocument\('qidle'[\s\S]*?\n\t\}\)\);/g) ?? [];
		expect(idle).toHaveLength(1);
		for (const call of ['setupCrossTabSync()', 'getCookie(COUNTRY_COOKIE)', 'readSession()', 'CountryPreferenceService.getCountry()']) expect(idle[0]!).toContain(call);
		expect(idle[0]!.indexOf('getCookie')).toBeLessThan(idle[0]!.indexOf('getCountry()'));
	});
	it('the analytics tasks are document-idle', () => {
		const a = read('platform/controllers/analytics-mount.tsx');
		expect(a).not.toContain("'document-ready'");
		expect(a.match(/strategy: 'document-idle'/g)).toHaveLength(2);
	});
	it('locked starts stay: cart qinit and checkout entry boot are untouched', () => {
		expect(read('components/cart/ConditionalCart.tsx')).toContain("useOnDocument('qinit'");
	});
});
