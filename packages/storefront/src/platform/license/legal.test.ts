import { describe, expect, it } from 'vitest';
import type { BrandLicense } from '~/platform/brand-data';
import { checkoutLegalContract, confirmationLegalLinks, isCheckoutPaused, legalLinks, sellerLine, supportEmailFor } from './legal';
import { commerceFlowFrom, routesDirFor } from './flow';
import { fallbackVariant, fmtMoney } from './variant';

const CONTRACT = { acceptanceVersion: 'a-v1', agreementStatement: 'I agree.', documents: [{ role: 'eula' as const, id: 'x', version: '1.0', sha256: 'a'.repeat(64), url: 'https://a.test/legal/eula/', treatment: 'agree' as const }] };
const DATA: BrandLicense = {
	version: 1,
	seller: { line: 'Example LLC · 1 Main St', supportLocalPart: 'hello' },
	pausedAppKeys: ['beta'],
	contracts: { alpha: CONTRACT },
	confirmationLegalLinks: { alpha: { privacy: '/privacy/', terms: '/terms/', refund: '/refund/', contact: '/contact/' }, default: { privacy: '/p', terms: '/t', refund: '/r', contact: '/c' } },
};

describe('license flow legal data', () => {
	it('the acceptance contract by app key, case-insensitive; none for an unknown or empty key or without data', () => {
		expect(checkoutLegalContract('alpha', DATA)).toBe(CONTRACT);
		expect(checkoutLegalContract('ALPHA', DATA)).toBe(CONTRACT);
		expect(checkoutLegalContract('beta', DATA)).toBeNull();
		expect(checkoutLegalContract('toString', DATA)).toBeNull();
		expect(checkoutLegalContract(null, DATA)).toBeNull();
		expect(checkoutLegalContract('alpha', null)).toBeNull();
	});

	it('paused apps; the seller line and support address', () => {
		expect(isCheckoutPaused('beta', DATA)).toBe(true);
		expect(isCheckoutPaused('alpha', DATA)).toBe(false);
		expect(isCheckoutPaused(null, DATA)).toBe(false);
		expect(isCheckoutPaused('beta', null)).toBe(false);
		expect(sellerLine(DATA)).toBe('Example LLC · 1 Main St');
		expect(supportEmailFor('a.test', DATA)).toBe('hello@a.test');
		expect(supportEmailFor('a.test', null)).toBe('support@a.test');
	});

	it('checkout links sit on the canonical domain; confirmation links: own, default, built-in', () => {
		expect(legalLinks('a.test')).toMatchObject({ privacy: 'https://a.test/privacy/', eula: 'https://a.test/legal/eula/', productSchedule: 'https://a.test/legal/product-schedule/' });
		expect(confirmationLegalLinks('alpha', DATA).privacy).toBe('/privacy/');
		expect(confirmationLegalLinks('gamma', DATA).privacy).toBe('/p');
		expect(confirmationLegalLinks('gamma', null)).toEqual({ privacy: '/privacy', terms: '/terms', refund: '/refund', contact: '/contact' });
	});
});

describe('license flow build constants', () => {
	it('only the exact value license selects the license flow and its route tree', () => {
		expect(commerceFlowFrom('license')).toBe('license');
		for (const v of [undefined, '', 'cart', 'License', 'licence']) expect(commerceFlowFrom(v)).toBe('cart');
		expect(routesDirFor('license')).toBe('src/platform/license/routes');
		expect(routesDirFor('cart')).toBe('src/routes');
	});

	it('money: whole dollars without cents, otherwise two decimals; a variant without hosts.json', () => {
		expect(fmtMoney(2900)).toBe('$29');
		expect(fmtMoney(2950)).toBe('$29.50');
		expect(fallbackVariant()).toMatchObject({ key: 'store', style: '' });
	});
});
