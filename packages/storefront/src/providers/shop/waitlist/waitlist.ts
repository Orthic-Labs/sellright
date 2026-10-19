import { SellRightError, sellright } from '~/sellright/client';

export interface RestockRequestInput {
	productId: string;
	email: string;
	turnstileToken: string;
	honeypot: string;
}

/** One product-level request; API owns enabled-variant expansion, security & notification delivery. */
export async function requestRestock(input: RestockRequestInput): Promise<{ success: boolean; message?: string }> {
	try {
		const { data } = await sellright().POST('/v1/shop/restock-request', { body: input });
		return data?.ok === true ? { success: true } : { success: false, message: 'Could not submit. Please try again.' };
	} catch (error) {
		const status = error instanceof SellRightError ? error.status : 0;
		return { success: false, message: status === 429 ? 'Too many attempts. Please try again later.'
			: status === 400 || status === 403 ? 'Please complete the security check and try again.'
			: status === 404 ? 'This product is no longer available.' : 'Could not submit. Please try again.' };
	}
}
