import { $, component$, useSignal, type QRL, type Signal } from '@qwik.dev/core';
import { StripePaymentElement } from '~/components/checkout/StripePaymentElement';
import { NMI } from '~/components/payment/NMI';
import { Sezzle } from '~/components/payment/Sezzle';
import { INSTALLMENT_PROVIDER } from '~/platform/payments/labels';
import { formatCents } from '~/hooks/checkout-total';
import type { PaymentMethod, ResumeView } from '~/hooks/useCheckout';
import type { ShopConfig } from '~/sellright/types/checkout';
import { availableMethods, METHOD_LABEL } from './CheckoutPaymentPanel';
import { PaymentInitRetry, type PaymentInitState } from './PaymentInitRetry';
import { bumpView } from './view-generation';

interface CheckoutResumePanelProps {
	gatewayConfirmTrigger: Signal<number>;
	onGatewaySuccess$: QRL<() => void>;
	onPaymentInitError$: QRL<(message: string, mountGen?: number) => void>;
	onPaymentError$: QRL<(message: string, mountGen?: number) => void>;
	onPaymentProcessingChange$: QRL<(processing: boolean, mountGen?: number) => void>;
	onResumeMethod$: QRL<(method: PaymentMethod) => void>;
	onResumeRetry$: QRL<() => void>;
	onStartNewCart$: QRL<() => void>;
	paymentInit: PaymentInitState;
	paymentMethod: Signal<PaymentMethod>;
	shopConfig: Signal<ShopConfig | null>;
	srState: {
		resume: ResumeView;
		resumeLines: { name: string; quantity: number }[];
		code: string;
		receiptToken: string;
		clientSecret: string;
		grandTotal: number;
		error: string | null;
		paymentError: string | null;
	};
	state: { loading: boolean };
	stripeConfirmTrigger: Signal<number>;
	stripePublishableKey: Signal<string>;
}

/**
 * Minimal payment view for resuming the ORIGINAL order of a converted cart.
 *
 * It deliberately shares only payment initialisation (`useCheckout.resumeConverted`) and the payment components with
 * the normal checkout. It is NOT `CheckoutPaymentPanel`: that panel hides its payment controls until a customer and
 * a shipping address validate, which a returning shopper with an empty form can never satisfy — the unpaid order
 * would be unpayable. Nothing here reads the cart, stock, shipping or form state, and nothing here creates an order.
 */
export const CheckoutResumePanel = component$<CheckoutResumePanelProps>((props) => {
	const switchingMethod = useSignal(false);
	const view = props.srState.resume;
	const methods = availableMethods(props.shopConfig.value);
	const total = props.srState.grandTotal > 0 ? formatCents(props.srState.grandTotal) : null;
	const payLabel = total ? `PAY — ${total}` : 'PAY';
	return (
		<div class="min-h-screen" style="background:var(--color-parchment);" data-testid="checkout-resume">
			<div class="max-w-xl mx-auto pt-10 pb-10 px-5">
				<h1 class="font-heading" style="font-size:26px;font-weight:400;color:#141210;letter-spacing:0.02em;margin-bottom:8px;">
					{view === 'error' ? 'Checkout' : 'Finish your order'}
				</h1>

				{view === 'loading' && (
					<p class="payment-placeholder" style="padding:14px 0;" role="status">Loading your order...</p>
				)}

				{view === 'error' && (
					<div role="alert" style="padding:12px 16px;border-radius:6px;border:1px solid rgba(var(--color-accent-rgb),0.25);background:rgba(var(--color-accent-rgb),0.06);font-size:13px;color:#141210;">
						<p style="margin:0 0 10px;">{props.srState.error || "We couldn't load your order. Please try again."}</p>
						<button type="button" class="checkout-cta" onClick$={$(() => props.onResumeRetry$())}>
							Try again
						</button>
					</div>
				)}

				{view === 'settled' && (
					<p class="payment-placeholder" style="padding:14px 0;" role="status">
						Payment received. Taking you to your order...
					</p>
				)}

				{view === 'cancelled' && (
					<div role="status" style="padding:12px 16px;border-radius:6px;border:1px solid rgba(100,85,65,0.2);font-size:13px;color:#141210;">
						<p style="margin:0 0 4px;">Order {props.srState.code} was cancelled.</p>
						<p style="margin:0 0 12px;">You can start a new cart.</p>
						<button type="button" class="checkout-cta" onClick$={$(() => props.onStartNewCart$())}>
							Start a new cart
						</button>
					</div>
				)}

				{view === 'payable' && (
					<>
						<p style="font-size:13px;color:rgba(100,85,65,0.75);margin:0 0 16px;">
							Order {props.srState.code}
							{total ? ` — ${total}` : ''}
						</p>
						{props.srState.resumeLines.length > 0 && (
							<ul style="list-style:none;margin:0 0 18px;padding:0;font-size:13px;color:#141210;">
								{props.srState.resumeLines.map((line, i) => (
									<li key={`${line.name}-${i}`} style="padding:4px 0;">
										{line.quantity} × {line.name}
									</li>
								))}
							</ul>
						)}
						{props.srState.paymentError && (
							<div role="alert" style="margin:0 0 14px;padding:10px 14px;border-radius:6px;border:1px solid rgba(var(--color-accent-rgb),0.25);background:rgba(var(--color-accent-rgb),0.06);font-size:13px;color:#141210;">
								{props.srState.paymentError}
							</div>
						)}
						{methods.length > 1 && (
							<div role="radiogroup" aria-label="Payment method" class="flex gap-2" style="margin-bottom:14px;">
								{methods.map((m) => (
									<button
										key={m}
										type="button"
										role="radio"
										aria-checked={props.paymentMethod.value === m}
										disabled={props.state.loading || switchingMethod.value}
										onClick$={$(async () => {
											if (switchingMethod.value || props.state.loading || props.paymentMethod.value === m) return;
											// Lock before dispatch: the route QRL may still need to load before its resume queue can run.
											switchingMethod.value = true;
											props.paymentMethod.value = m;
											// A method switch replaces the payment view: in-flight callbacks of the old one are rejected.
											bumpView(props.paymentInit);
											try {
												await props.onResumeMethod$(m);
											} catch {
												props.srState.error = "We couldn't load your payment options. Please try again.";
												props.srState.resume = 'error';
											} finally {
												switchingMethod.value = false;
											}
										})}
										class="payment-method-option"
										style={{
											flex: '1', padding: '10px 12px', fontSize: '13px', borderRadius: '4px', cursor: 'pointer',
											border: props.paymentMethod.value === m ? '1px solid var(--color-accent)' : '1px solid rgba(100,85,65,0.2)',
											background: props.paymentMethod.value === m ? 'rgba(var(--color-accent-rgb),0.06)' : 'transparent',
										}}
									>
										{METHOD_LABEL[m]}
									</button>
								))}
							</div>
						)}
						{switchingMethod.value ? (
							<p class="payment-placeholder" style="padding:14px 0;" role="status">Preparing payment...</p>
						) : props.paymentInit.failed ? (
							<PaymentInitRetry init={props.paymentInit} />
						) : props.paymentMethod.value === 'stripe' && props.stripePublishableKey.value && props.srState.clientSecret ? (
							<>
								<StripePaymentElement
									key={props.paymentInit.key}
									mountGen={props.paymentInit.gen}
									onInitError$={props.onPaymentInitError$}
									publishableKey={props.stripePublishableKey.value}
									clientSecret={props.srState.clientSecret}
									returnUrl={`${typeof location !== 'undefined' ? location.origin : ''}/checkout/confirmation/${encodeURIComponent(props.srState.code)}${props.srState.receiptToken ? `?rt=${encodeURIComponent(props.srState.receiptToken)}` : ''}`}
									confirmTrigger={props.stripeConfirmTrigger}
									onError$={props.onPaymentError$}
									onProcessingChange$={props.onPaymentProcessingChange$}
								/>
								<button
									type="button"
									onClick$={$(() => {
										if (props.state.loading || switchingMethod.value) return;
										props.stripeConfirmTrigger.value = props.stripeConfirmTrigger.value + 1;
									})}
									disabled={props.state.loading || switchingMethod.value}
									class="checkout-cta"
									style="margin-top:14px;"
								>
									{props.state.loading ? 'Processing...' : payLabel}
								</button>
							</>
						) : props.paymentMethod.value === 'nmi' && props.shopConfig.value?.gateways?.nmi ? (
							<>
								<NMI
									key={props.paymentInit.key}
									mountGen={props.paymentInit.gen}
									onInitError$={props.onPaymentInitError$}
									code={props.srState.code}
									tokenizationKey={props.shopConfig.value.gateways.nmi.tokenizationKey}
									mode={props.shopConfig.value.gateways.nmi.mode}
									environment={props.shopConfig.value.gateways.nmi.environment}
									receiptToken={props.srState.receiptToken || undefined}
									confirmTrigger={props.gatewayConfirmTrigger}
									onError$={props.onPaymentError$}
									onProcessingChange$={props.onPaymentProcessingChange$}
									onSuccess$={props.onGatewaySuccess$}
								/>
								<button
									type="button"
									onClick$={$(() => {
										if (props.state.loading || switchingMethod.value) return;
										props.gatewayConfirmTrigger.value = props.gatewayConfirmTrigger.value + 1;
									})}
									disabled={props.state.loading || switchingMethod.value}
									class="checkout-cta"
									style="margin-top:14px;"
								>
									{props.state.loading ? 'Processing...' : payLabel}
								</button>
							</>
						) : props.paymentMethod.value === INSTALLMENT_PROVIDER ? (
							<Sezzle
								mountGen={props.paymentInit.gen}
								code={props.srState.code}
								receiptToken={props.srState.receiptToken || undefined}
								label={total ? `Continue — ${total}` : 'Continue'}
								disabled={props.state.loading || switchingMethod.value}
								onError$={props.onPaymentError$}
								onProcessingChange$={props.onPaymentProcessingChange$}
							/>
						) : methods.includes(props.paymentMethod.value) ? (
							// A method is selected but its payment is still being initialised (a switch in flight): never claim the
							// store has no method configured while a selection exists.
							<p class="payment-placeholder" style="padding:14px 0;" role="status">Preparing payment...</p>
						) : (
							<div class="payment-placeholder text-red-600" style="padding:14px 0;" role="alert">
								No payment method is configured for this store — please contact support.
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
});
