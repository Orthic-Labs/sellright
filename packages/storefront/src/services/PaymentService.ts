import { getShopConfig } from '~/providers/shop/checkout/checkout';

/**
 * API-driven payment methods — no static JSON list. This storefront's only
 * tender is Stripe (the Payment Element), gated on the store's own runtime
 * config (`GET /v1/shop/config`); a store without Stripe wired shows none.
 */
export interface PaymentMethodOption {
	code: 'stripe';
	enabled: boolean;
	name: string;
	description: string;
}

export class PaymentService {
	static async getPaymentMethods(): Promise<PaymentMethodOption[]> {
		const config = await getShopConfig();
		if (!config.stripeConfigured) return [];
		return [{ code: 'stripe', enabled: true, name: 'Card', description: 'Pay securely by card' }];
	}
}
