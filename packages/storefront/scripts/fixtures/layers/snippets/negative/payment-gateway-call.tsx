// expect-shape: orchestration-call
import { loadStripe } from '@stripe/stripe-js';

export const mount = async () => {
	const stripe = await loadStripe('pk_test_fixture');
	(window as unknown as { CollectJS: { configure: (o: object) => void } }).CollectJS.configure({});
	return stripe;
};
