import { $, component$ } from '@qwik.dev/core';
import { bumpView, type ViewGeneration } from './view-generation';

/** Shared state of the mounted payment component: `failed` once it could not LOAD, `key` remounts it on retry. */
export interface PaymentInitState extends ViewGeneration {
	failed: boolean;
	key: number;
}

/**
 * Retry for a payment component that failed to initialise (SDK blocked, network drop). The order — and, for Stripe, its
 * client secret — is untouched: retry only remounts the component. A declined payment is a different case and keeps
 * the mounted component and its own PAY button.
 */
export const PaymentInitRetry = component$<{ init: PaymentInitState }>((props) => (
	<div role="alert" data-testid="payment-init-failed" style="margin:0 0 14px;padding:12px 16px;border-radius:6px;border:1px solid rgba(var(--color-accent-rgb),0.25);background:rgba(var(--color-accent-rgb),0.06);font-size:13px;color:#141210;">
		<p style="margin:0 0 10px;">Secure payment couldn't load. Please try again.</p>
		<button
			type="button"
			class="checkout-cta"
			onClick$={$(() => {
				props.init.failed = false;
				props.init.key = props.init.key + 1;
				// The remounted component is a new view: callbacks still in flight from the failed one are rejected.
				bumpView(props.init);
			})}
		>
			Try again
		</button>
	</div>
));
