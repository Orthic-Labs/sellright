import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';
import { getShopConfig } from './api';

// Lazy Stripe.js: the publishable key of the store's active mode comes from GET /v1/shop/config at runtime (no build env).
// Until a mode is configured this resolves to null and checkout shows the "payment not yet enabled" state.
let promise: Promise<Stripe | null> | null = null;

export function getStripe(): Promise<Stripe | null> {
	if (!promise) {
		promise = (async () => {
			try {
				const cfg = await getShopConfig();
				if (!cfg.stripeConfigured || !cfg.stripePublishableKey) return null;
				return await loadStripe(cfg.stripePublishableKey);
			} catch {
				return null;
			}
		})();
	}
	return promise;
}
