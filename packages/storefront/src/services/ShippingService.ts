import { getEligibleShippingMethods } from '~/providers/shop/checkout/checkout';

/**
 * API-driven shipping methods — no static JSON list. Rates are server-priced
 * per destination + subtotal (`GET /v1/shop/shipping-methods`); the storefront
 * never guesses a rate client-side.
 */
export interface ShippingMethod {
	id: string;
	code: string;
	name: string;
	description: string;
	/** Cents. */
	price: number;
	/** Cents (this API has no separate tax-exclusive rate — same as `price`). */
	priceWithTax: number;
}

export class ShippingService {
	static async getEligibleShippingMethods(countryCode: string, subtotal: number): Promise<ShippingMethod[]> {
		const methods = await getEligibleShippingMethods(countryCode, subtotal);
		return methods.map((m) => ({
			id: m.code,
			code: m.code,
			name: m.name,
			description: '',
			price: m.rate,
			priceWithTax: m.rate,
		}));
	}
}
