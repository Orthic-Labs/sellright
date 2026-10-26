// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/platform/brand-data', () => ({
	BRAND_HEAD: { analytics: { provider: 'gtm', containerId: 'GTM-TEST', consent: 'implied' } },
	BRAND_ROUTES: {},
}));

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

type Pushed = { event?: string; event_id?: string; ecommerce?: { transaction_id?: string; value_minor?: number } | null; user_data?: Record<string, string> };

const paid = (over: Record<string, unknown> = {}) => ({
	code: 'RH000100',
	state: 'Paid',
	currency: 'USD',
	grandTotal: 7500,
	lines: [{ sku: 'SKU-1', name: 'Shirt', quantity: 1, lineTotal: 7500 }],
	testMode: false,
	contactEmail: '  Buyer@Example.COM ',
	customerEmail: null,
	shippingAddress: { phone: '(503) 227-1234', country: 'US' },
	...over,
});

async function freshConversion() {
	vi.resetModules();
	sessionStorage.clear();
	(window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
	const mod = await import('./conversion');
	mod.startConversion();
	return mod;
}

const purchases = () => ((window as unknown as { dataLayer: Pushed[] }).dataLayer).filter((e) => e.event === 'purchase');

describe('purchase conversion (#373): paid live orders only, hashed identifiers, once per order', () => {
	beforeEach(() => {
		(window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
	});

	it('sends nothing for an order that is not paid: pending, declined, cancelled', async () => {
		const { trackPurchaseOnce } = await freshConversion();
		for (const state of ['PendingPayment', 'Declined', 'Cancelled', undefined]) {
			await trackPurchaseOnce(paid({ state, code: `RH-${state}` }));
		}
		expect(purchases()).toEqual([]);
	});

	it('sends nothing for a test-mode purchase', async () => {
		const { trackPurchaseOnce } = await freshConversion();
		await trackPurchaseOnce(paid({ testMode: true }));
		expect(purchases()).toEqual([]);
	});

	it('a paid live order sends exactly one purchase with SHA-256 email (trimmed, lowercased) and E.164 phone, never raw', async () => {
		const { trackPurchaseOnce } = await freshConversion();
		await trackPurchaseOnce(paid());
		const sent = purchases();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.event_id).toBe('purchase_RH000100');
		expect(sent[0]!.ecommerce?.transaction_id).toBe('RH000100');
		expect(sent[0]!.ecommerce?.value_minor).toBe(7500);
		expect(sent[0]!.user_data).toEqual({ sha256_email_address: sha('buyer@example.com'), sha256_phone_number: sha('+15032271234') });
		const raw = JSON.stringify(sent[0]);
		expect(raw).not.toMatch(/buyer@example\.com|Buyer@|503|227/i);
	});

	it('a reload or replay of the confirmation page still sends one', async () => {
		const { trackPurchaseOnce } = await freshConversion();
		await trackPurchaseOnce(paid());
		await trackPurchaseOnce(paid());
		await trackPurchaseOnce(paid());
		expect(purchases()).toHaveLength(1);
	});

	it('an order with no usable email or phone sends the purchase without user_data', async () => {
		const { trackPurchaseOnce } = await freshConversion();
		await trackPurchaseOnce(paid({ contactEmail: 'not-an-email', shippingAddress: { phone: '12', country: 'US' } }));
		const sent = purchases();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.user_data).toBeUndefined();
	});

	it('the account email is used when there is no checkout contact email', async () => {
		const { trackPurchaseOnce } = await freshConversion();
		await trackPurchaseOnce(paid({ contactEmail: null, customerEmail: 'acct@example.com', shippingAddress: null }));
		expect(purchases()[0]!.user_data).toEqual({ sha256_email_address: sha('acct@example.com') });
	});
});
