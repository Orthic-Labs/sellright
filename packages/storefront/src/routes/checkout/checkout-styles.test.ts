import { describe, expect, it } from 'vitest';
import { CHECKOUT_STYLES } from './checkout-styles';

const mobile = () => {
	const start = CHECKOUT_STYLES.indexOf('@media (max-width:767px)');
	expect(start).toBeGreaterThan(-1);
	return CHECKOUT_STYLES.slice(start);
};

describe('checkout mobile spacing (#404)', () => {
	it('keeps the payment-to-footer gap small instead of reserving the sticky bar inside the column', () => {
		const css = mobile();
		expect(css).toContain('.checkout-right-inner{padding-bottom:10px!important}');
		expect(css).toContain('.checkout-right{margin-bottom:0!important}');
		expect(css).toContain('.checkout-container{padding-bottom:0!important}');
		expect(CHECKOUT_STYLES).not.toContain('padding-bottom:90px');
	});

	it('reserves the sticky bar height after the footer, below 768px only', () => {
		const rule = 'body:has(.sticky-cta-bar){padding-bottom:calc(72px + env(safe-area-inset-bottom))}';
		expect(mobile()).toContain(rule);
		expect(CHECKOUT_STYLES.indexOf(rule)).toBeGreaterThan(CHECKOUT_STYLES.indexOf('@media (max-width:767px)'));
	});
});

describe('checkout sticky CTA (CLS)', () => {
	it('the total column keeps a fixed minimum width so PLACE ORDER does not narrow when the total arrives', () => {
		const css = mobile();
		expect(css).toMatch(/\.sticky-cta-total\{\s*flex:0 0 auto;\s*min-width:96px;/);
		expect(css).toContain('.sticky-cta-total-amount{white-space:nowrap}');
	});
});
