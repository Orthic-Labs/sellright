import { $, component$, Slot, useComputed$, useContext, useSignal, type QRL, type ReadonlySignal, type Signal } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { billingDefaultValues } from './payment-element-options';
import { CheckoutAddresses } from '~/components/checkout/CheckoutAddresses';
import { PaymentLock } from './LockedPaymentBox';
import { StripePaymentElement } from '~/components/checkout/StripePaymentElement';
import { NMI } from '~/components/payment/NMI';
import { Sezzle } from '~/components/payment/Sezzle';
import { PaymentMethodTab, methodTabClass } from '~/components/payment/PaymentMethodTab';
import { INSTALLMENT_PROVIDER, PROVIDER_LABELS } from '~/platform/payments/labels';
import type { ShopConfig } from '~/sellright/types/checkout';
import type { CheckoutPhase, PaymentMethod } from '~/hooks/useCheckout';
import { totalChange, formatCents, needsTotalConsent } from '~/hooks/checkout-total';
import { CheckoutDesktopCta } from './CheckoutCta';
import { PaymentInitRetry, type PaymentInitState } from './PaymentInitRetry';
import { bumpView } from './view-generation';
import { paymentControlsMounted, stripeElementMountable, type PayableOrder } from './payable-order';

interface CheckoutPaymentPanelProps {
	checkoutState: any;
	checkoutValidation: any;
	formattedTotal: Signal<string | null>;
	gatewayConfirmTrigger: Signal<number>;
	totalConfirmed: Signal<boolean>;
	isOrderProcessing: Signal<boolean>;
	onGatewaySuccess$: QRL<() => void>;
	onPaymentInitError$: QRL<(message: string, mountGen?: number) => void>;
	onPaymentError$: QRL<(message: string, mountGen?: number) => void>;
	/** A payment form's own validation message (before any order): shown as is. */
	onPaymentFieldError$: QRL<(message: string, mountGen?: number) => void>;
	onPaymentProcessingChange$: QRL<(processing: boolean, mountGen?: number) => void>;
	onPlaceOrder$: QRL<() => void>;
	pageLoading: Signal<boolean>;
	paymentInit: PaymentInitState;
	paymentMethod: Signal<PaymentMethod>;
	shopConfig: Signal<ShopConfig | null>;
	srState: { phase: CheckoutPhase; code: string; receiptToken: string; clientSecret: string; grandTotal: number; shownTotal: number };
	state: { loading: boolean; error: string | null };
	stripeConfirmTrigger: Signal<number>;
	stripePublishableKey: Signal<string>;
	/** #372: the order PAY charges — created on the first PAY, before that the controls are mounted with no order. */
	ensureOrder$: QRL<() => Promise<PayableOrder | null>>;
	/** The total shown to the shopper (cents): the Stripe element's amount before the order exists. */
	chargeTotalCents: ReadonlySignal<number>;
	currency: string;
}

import { availableMethods } from './locked-payment';
export { availableMethods };

// Shopper-facing: the NMI card form reads as "Card", not the processor's name (Stripe shows its own method tabs).
export const METHOD_LABEL: Readonly<Record<keyof typeof PROVIDER_LABELS, string>> = { ...PROVIDER_LABELS, nmi: 'Card' };

export const CheckoutPaymentPanel = component$<CheckoutPaymentPanelProps>((props) => {
	// #400: the Payment Element's billing country/ZIP follow the checkout address (never the visitor's geo country).
	const appState = useContext(APP_STATE);
	const billingDefaults = useComputed$(() => billingDefaultValues(appState.billingAddress, appState.shippingAddress));
	const methods = availableMethods(props.shopConfig.value);
	// NMI hosted fields: PLACE ORDER stays disabled until Collect.js reports them usable (a press before that did nothing).
	const cardFieldsReady = useSignal(false);
	const locked = props.srState.phase === 'paying' || props.srState.phase === 'placing';
	// Once the order exists the amount charged is ITS server-priced grandTotal — never the estimate the shopper
	// saw while filling the form. When the two differ, charging waits for the shopper's explicit confirmation.
	const paying = props.srState.phase === 'paying';
	const change = totalChange(props.srState.shownTotal, props.srState.grandTotal);
	const chargeLabel = paying && props.srState.grandTotal > 0 ? formatCents(props.srState.grandTotal) : null;
	const needsConsent = paying && needsTotalConsent(props.srState.shownTotal, props.srState.grandTotal, props.totalConfirmed.value);
	// #372: the payment controls are mounted as soon as the details are valid, before the order exists (PAY creates it),
	// and stay the SAME mounted component through order creation ('placing') into 'paying', so a charge in flight is never
	// dropped by a remount. 'paid' leaves for confirmation; an order that failed after creation is recovered by the page.
	// Nothing to pay (a gift card, credit or discount covers it): no payment controls; PLACE ORDER completes the order.
	const mountInput = { phase: props.srState.phase, code: props.srState.code, clientSecret: props.srState.clientSecret, chargeTotalCents: props.chargeTotalCents.value };
	const controls = paymentControlsMounted(mountInput);
	const payLabel = chargeLabel ?? props.formattedTotal.value;
	const detailsValid = props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid;
	return (
	<div class="checkout-right order-1 lg:order-2 mb-8 lg:mb-0 lg:basis-[58%]">
		<div class="checkout-right-inner" style="padding:8px 20px 32px;">
			<Slot name="lead" />
			<div style="display:flex;align-items:center;gap:0;margin-bottom:24px;padding:4px 0;">
				<div style="display:flex;align-items:center;gap:8px;">
					<div style={{
						width: '24px', height: '24px', borderRadius: '50%',
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						fontSize: '11px', fontWeight: '500',
						background: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? 'var(--color-accent)' : '#141210',
						color: '#FDFAF6', transition: 'background 0.3s',
					}}>
						{props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? (
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FDFAF6" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
						) : '1'}
					</div>
					<span style={{
						fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
						color: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? 'var(--color-accent)' : '#141210',
						fontWeight: '500', transition: 'color 0.3s',
					}}>Shipping</span>
				</div>
				<div style={{
					flex: '1', height: '1px', margin: '0 12px',
					background: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? 'var(--color-accent)' : 'rgba(100,85,65,0.15)',
					transition: 'background 0.3s',
				}} />
				<div style="display:flex;align-items:center;gap:8px;">
					<div style={{
						width: '24px', height: '24px', borderRadius: '50%',
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						fontSize: '11px', fontWeight: '500',
						background: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#141210' : 'rgba(100,85,65,0.12)',
						color: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#FDFAF6' : 'rgba(100,85,65,0.4)',
						transition: 'all 0.3s',
					}}>2</div>
					<span style={{
						fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
						color: props.checkoutValidation.isShippingAddressValid && props.checkoutValidation.isCustomerValid ? '#141210' : 'rgba(100,85,65,0.35)',
						fontWeight: '500', transition: 'color 0.3s',
					}}>Payment</span>
				</div>
			</div>
			<div class="mb-3">
				{props.pageLoading.value ? (
					<div class="animate-pulse" style="padding-top:8px;">
						<div style="height:14px;width:140px;border-radius:4px;background:rgba(100,85,65,0.1);margin-bottom:20px;" />
						<div class="flex gap-3" style="margin-bottom:14px;">
							<div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
							<div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
						</div>
						<div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:14px;" />
						<div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:24px;" />
						<div style="height:14px;width:160px;border-radius:4px;background:rgba(100,85,65,0.1);margin-bottom:20px;" />
						<div style="height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);margin-bottom:14px;" />
						<div class="flex gap-3" style="margin-bottom:14px;">
							<div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
							<div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
						</div>
						<div class="flex gap-3">
							<div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
							<div style="flex:1;height:42px;border-radius:4px;background:rgba(100,85,65,0.06);border:1px solid rgba(100,85,65,0.08);" />
						</div>
					</div>
				) : (
					<CheckoutAddresses />
				)}
			</div>
			<div id="checkout-payment-section" style="margin-bottom:14px;scroll-margin-top:16px;">
				<div
					class="grid transition-all duration-500 ease-out"
					style={{
						gridTemplateRows: (props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid) ? '1fr' : '0fr',
						opacity: (props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid) ? '1' : '0',
					}}
				>
					<div class="overflow-hidden">
						<div id="payment-method-section" style="scroll-margin-top:16px;">
							<>
										{paying && change.changed && (
											<div
												role="alert"
												data-testid="total-changed"
												style="margin-bottom:14px;padding:12px 16px;border-radius:6px;border:1px solid rgba(var(--color-accent-rgb),0.35);background:rgba(var(--color-accent-rgb),0.06);font-size:13px;color:#141210;font-family:var(--font-body);"
											>
												<p style="margin:0 0 8px;font-weight:500;">Your order total changed.</p>
												<p style="margin:0 0 10px;">
													You were shown {formatCents(change.shownCents)}; the order total is now {formatCents(change.chargeCents)}.
												</p>
												<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
													<input
														type="checkbox"
														checked={props.totalConfirmed.value}
														onChange$={(_, el) => { props.totalConfirmed.value = el.checked; }}
														style="flex:none;width:16px;height:16px;margin-top:1px;border:1px solid rgba(100,85,65,0.55);border-radius:2px;background-color:#fff;cursor:pointer;"
													/>
													<span>I confirm I will be charged {formatCents(change.chargeCents)}</span>
												</label>
											</div>
										)}
										{methods.length > 1 && (
											<div role="radiogroup" aria-label="Payment method" class="grid grid-flow-col auto-cols-fr gap-1 w-full rounded-md border border-black/10 bg-black/5 p-1 mb-5">
												{methods.map((m) => (
													<button
														key={m}
														type="button"
														role="radio"
														aria-checked={props.paymentMethod.value === m}
														disabled={locked}
														onClick$={$(() => {
															if (locked) return;
															props.paymentMethod.value = m;
															// A method switch replaces the payment view: in-flight callbacks of the old one are rejected.
															bumpView(props.paymentInit);
														})}
														class={methodTabClass(props.paymentMethod.value === m)}
													>
														<PaymentMethodTab method={m} label={METHOD_LABEL[m]} />
													</button>
												))}
											</div>
										)}
										{controls && props.paymentInit.failed ? (
											<PaymentInitRetry init={props.paymentInit} />
										) : controls && props.paymentMethod.value === 'stripe' && props.stripePublishableKey.value && stripeElementMountable(mountInput) ? (
											<>
												<StripePaymentElement
													key={props.paymentInit.key}
									mountGen={props.paymentInit.gen}
													onInitError$={props.onPaymentInitError$}
													publishableKey={props.stripePublishableKey.value}
													clientSecret={props.srState.clientSecret}
													amount={props.chargeTotalCents.value}
													currency={props.currency}
													ensureOrder$={props.ensureOrder$}
													onValidationError$={props.onPaymentFieldError$}
													returnUrl={`${typeof location !== 'undefined' ? location.origin : ''}/checkout/confirmation/${encodeURIComponent(props.srState.code)}${props.srState.receiptToken ? `?rt=${encodeURIComponent(props.srState.receiptToken)}` : ''}`}
													confirmTrigger={props.stripeConfirmTrigger}
													onError$={props.onPaymentError$}
													onProcessingChange$={props.onPaymentProcessingChange$}
													billingDefaults={billingDefaults.value}
												/>
												<button
													type="button"
													onClick$={$(() => {
														if (props.state.loading) return;
														if (needsTotalConsent(props.srState.shownTotal, props.srState.grandTotal, props.totalConfirmed.value)) return;
														props.stripeConfirmTrigger.value = props.stripeConfirmTrigger.value + 1;
													})}
													disabled={props.state.loading || props.isOrderProcessing.value || needsConsent}
													class="checkout-cta"
													style="margin-top:14px;"
												>
													{props.state.loading
														? 'Processing...'
														: (payLabel ? `PLACE ORDER — ${payLabel}` : 'PLACE ORDER')}
												</button>
											</>
										) : controls && props.paymentMethod.value === 'nmi' && props.shopConfig.value?.gateways?.nmi ? (
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
													ensureOrder$={props.ensureOrder$}
													onReadyChange$={$((ready: boolean) => { cardFieldsReady.value = ready; })}
												/>
												<button
													type="button"
													onClick$={$(() => {
														if (props.state.loading) return;
														if (needsTotalConsent(props.srState.shownTotal, props.srState.grandTotal, props.totalConfirmed.value)) return;
														props.gatewayConfirmTrigger.value = props.gatewayConfirmTrigger.value + 1;
													})}
													disabled={props.state.loading || props.isOrderProcessing.value || needsConsent || !cardFieldsReady.value}
													class="checkout-cta"
													style="margin-top:14px;"
												>
													{props.state.loading
														? 'Processing...'
														: !cardFieldsReady.value
															? 'Loading card fields…'
															: (payLabel ? `PLACE ORDER — ${payLabel}` : 'PLACE ORDER')}
												</button>
											</>
										) : controls && props.paymentMethod.value === INSTALLMENT_PROVIDER ? (
											<Sezzle
												mountGen={props.paymentInit.gen}
												code={props.srState.code}
												receiptToken={props.srState.receiptToken || undefined}
												totalCents={paying && props.srState.grandTotal > 0 ? props.srState.grandTotal : props.chargeTotalCents.value}
												currency={props.currency}
												disabled={props.state.loading || props.isOrderProcessing.value || needsConsent}
												ensureOrder$={props.ensureOrder$}
												onError$={props.onPaymentError$}
												onProcessingChange$={props.onPaymentProcessingChange$}
											/>
										) : controls && props.shopConfig.value && methods.length === 0 ? (
											<div class="payment-placeholder text-red-600" style="padding:14px 0;" role="alert">
												No payment method is configured for this store — please contact support.
											</div>
										) : controls || props.srState.phase === 'placing' ? (
											<div class="payment-placeholder" style="padding:14px 0;">
												Preparing secure payment...
											</div>
										) : null}
									</>
						</div>
					</div>
				</div>
				{/* #404: a locked payment box (not the faint one-line placeholder) until the details are valid; then the panel above
				    reveals with its existing transition and the status line announces the unlock. */}
				<PaymentLock unlocked={detailsValid} methods={methods} />
			</div>
			{props.state.error && (
				<div style={{
					display: 'flex', alignItems: 'center', gap: '10px',
					padding: '12px 16px', marginBottom: '12px',
					borderRadius: '6px', border: '1px solid rgba(var(--color-accent-rgb),0.25)',
					background: 'rgba(var(--color-accent-rgb),0.06)',
					fontSize: '13px', color: '#141210',
					fontFamily: 'var(--font-body)',
				}}>
					<svg width="16" height="16" viewBox="0 0 20 20" fill="var(--color-accent)" style={{ flexShrink: 0 }}>
						<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
					</svg>
					<span>{props.state.error}</span>
				</div>
			)}
			{/* The panel's own PAY replaces the CTA once the payment controls are showing. */}
			{!(paying || (detailsValid && controls)) && <CheckoutDesktopCta {...props} />}
		</div>
	</div>
	);
});
