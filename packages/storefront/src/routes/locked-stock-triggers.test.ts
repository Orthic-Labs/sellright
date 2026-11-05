// @vitest-environment node
// #360 owner addendum: the LOCKED stock reads and the checkout entry boot stay where they were. Only modals/menu/analytics/session/
// country/address-sync may move to idle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePlatformSettings } from '~/platform/settings';

const read = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('locked stock reads stay on their triggers (#360)', () => {
	it('PDP: brand stockRefreshTrigger qinit (dd, rh) is still honoured and the PDP hook follows it', () => {
		expect(resolvePlatformSettings({ 'pdp.stockRefreshTrigger': 'qinit' })['pdp.stockRefreshTrigger']).toBe('qinit');
		const t = read('platform/stock-triggers.ts');
		expect(t).toContain("useOnDocument(page === 'pdp' ? PDP_STOCK_TRIGGER : 'qidle'");
		expect(t).toContain("platformSettings['pdp.stockRefreshTrigger']");
	});
	it('shop live read stays on qidle', () => {
		expect(read('platform/stock-triggers.ts')).toMatch(/useOnDocument\('qidle', start\)/);
	});
	it('cart-open read (ConditionalCart) stays on qinit', () => {
		expect(read('components/cart/ConditionalCart.tsx')).toMatch(/useOnDocument\('qinit', \$\(async \(\) => \{\s*loadCartIfNeeded\(cart\)/);
	});
	it('CartProvider boot and checkout entry boot stay on qinit', () => {
		const c = read('contexts/CartContext.tsx');
		expect(c).toMatch(/useOnDocument\(\s*'qinit',[\s\S]*?startCheckoutEntryBoot\(/);
		expect(read('routes/checkout/index.tsx')).toContain('startCheckoutEntryBoot(location.pathname)');
	});
	it('the layout no longer touches any of them', () => {
		const l = read('routes/layout.tsx');
		for (const s of ['loadCartIfNeeded', 'startCheckoutEntryBoot', 'useStockTrigger', 'PDP_STOCK_TRIGGER']) expect(l).not.toContain(s);
	});
});
