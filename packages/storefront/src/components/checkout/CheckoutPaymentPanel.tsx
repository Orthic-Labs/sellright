import { $, component$, type QRL, type Signal } from '@qwik.dev/core';
import { CheckoutAddresses } from '~/components/checkout/CheckoutAddresses';
import { StripePaymentElement } from '~/components/checkout/StripePaymentElement';
import { NMI } from '~/components/payment/NMI';
import { Sezzle } from '~/components/payment/Sezzle';
import type { ShopConfig } from '~/sellright/types/checkout';
import type { CheckoutPhase, PaymentMethod } from '~/hooks/useCheckout';
import { totalChange, formatCents } from '~/hooks/checkout-total';
import { CheckoutDesktopCta } from './CheckoutCta';

interface CheckoutPaymentPanelProps {
	checkoutState: any;
	checkoutValidation: any;
	formattedTotal: Signal<string | null>;
	gatewayConfirmTrigger: Signal<number>;
	totalConfirmed: Signal<boolean>;
	isOrderProcessing: Signal<boolean>;
	onGatewaySuccess$: QRL<() => void>;
	onPaymentError$: QRL<(message: string) => void>;
	onPaymentProcessingChange$: QRL<(processing: boolean) => void>;
	onPlaceOrder$: QRL<() => void>;
	pageLoading: Signal<boolean>;
	paymentMethod: Signal<PaymentMethod>;
	shopConfig: Signal<ShopConfig | null>;
	srState: { phase: CheckoutPhase; code: string; receiptToken: string; clientSecret: string; grandTotal: number; shownTotal: number };
	state: { loading: boolean; error: string | null };
	stripeConfirmTrigger: Signal<number>;
	stripePublishableKey: Signal<string>;
}

/** The available-method list, derived from what `GET /v1/shop/config`
 *  actually reports for this store — never hardcoded, never assumed. */
function availableMethods(config: ShopConfig | null): PaymentMethod[] {
	if (!config) return [];
	const methods: PaymentMethod[] = [];
	if (config.stripeConfigured) methods.push('stripe');
	if (config.gateways?.nmi) methods.push('nmi');
	if (config.gateways?.sezzle) methods.push('sezzle');
	return methods;
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
	stripe: 'Card',
	nmi: 'Card',
	sezzle: 'Installments',
};

export const CheckoutPaymentPanel = component$<CheckoutPaymentPanelProps>((props) => {
	const methods = availableMethods(props.shopConfig.value);
	const locked = props.srState.phase === 'paying' || props.srState.phase === 'placing';
	// Once the order exists the amount charged is ITS server-priced grandTotal — never the estimate the shopper
	// saw while filling the form. When the two differ, charging waits for the shopper's explicit confirmation.
	const paying = props.srState.phase === 'paying';
	const change = totalChange(props.srState.shownTotal, props.srState.grandTotal);
	const chargeLabel = paying && props.srState.grandTotal > 0 ? formatCents(props.srState.grandTotal) : null;
	const needsConsent = paying && change.changed && !props.totalConfirmed.value;
	return (
	<div class="checkout-right order-1 lg:order-2 mb-8 lg:mb-0 lg:basis-[58%]">
		<div class="checkout-right-inner" style="padding:8px 20px 32px;">
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
											<div role="radiogroup" aria-label="Payment method" class="flex gap-2" style="margin-bottom:14px;">
												{methods.map((m) => (
													<button
														key={m}
														type="button"
														role="radio"
														aria-checked={props.paymentMethod.value === m}
														disabled={locked}
														onClick$={$(() => { if (!locked) props.paymentMethod.value = m; })}
														class="payment-method-option"
														style={{
															flex: '1', padding: '10px 12px', fontSize: '13px', borderRadius: '4px', cursor: locked ? 'default' : 'pointer',
															border: props.paymentMethod.value === m ? '1px solid var(--color-accent)' : '1px solid rgba(100,85,65,0.2)',
															background: props.paymentMethod.value === m ? 'rgba(var(--color-accent-rgb),0.06)' : 'transparent',
														}}
													>
														{METHOD_LABEL[m]}
													</button>
												))}
											</div>
										)}
										{props.srState.phase === 'paying' && props.paymentMethod.value === 'stripe' && props.stripePublishableKey.value && props.srState.clientSecret ? (
											<>
												<StripePaymentElement
													publishableKey={props.stripePublishableKey.value}
													clientSecret={props.srState.clientSecret}
													returnUrl={`${typeof location !== 'undefined' ? location.origin : ''}/checkout/confirmation/${props.srState.code}${props.srState.receiptToken ? `?rt=${encodeURIComponent(props.srState.receiptToken)}` : ''}`}
													confirmTrigger={props.stripeConfirmTrigger}
													onError$={props.onPaymentError$}
													onProcessingChange$={props.onPaymentProcessingChange$}
												/>
												<button
													type="button"
													onClick$={$(() => {
														if (props.state.loading) return;
														if (totalChange(props.srState.shownTotal, props.srState.grandTotal).changed && !props.totalConfirmed.value) return;
														props.stripeConfirmTrigger.value = props.stripeConfirmTrigger.value + 1;
													})}
													disabled={props.state.loading || needsConsent}
													class="checkout-cta"
													style="margin-top:14px;"
												>
													{props.state.loading
														? 'Processing...'
														: (chargeLabel ? `PAY — ${chargeLabel}` : 'PAY')}
												</button>
											</>
										) : props.srState.phase === 'paying' && props.paymentMethod.value === 'nmi' && props.shopConfig.value?.gateways?.nmi ? (
											<>
												<NMI
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
														if (props.state.loading) return;
														if (totalChange(props.srState.shownTotal, props.srState.grandTotal).changed && !props.totalConfirmed.value) return;
														props.gatewayConfirmTrigger.value = props.gatewayConfirmTrigger.value + 1;
													})}
													disabled={props.state.loading || needsConsent}
													class="checkout-cta"
													style="margin-top:14px;"
												>
													{props.state.loading
														? 'Processing...'
														: (chargeLabel ? `PAY — ${chargeLabel}` : 'PAY')}
												</button>
											</>
										) : props.srState.phase === 'paying' && props.paymentMethod.value === 'sezzle' ? (
											<Sezzle
												code={props.srState.code}
												receiptToken={props.srState.receiptToken || undefined}
												label={chargeLabel ? `Continue — ${chargeLabel}` : 'Continue'}
												disabled={props.state.loading || needsConsent}
												onError$={props.onPaymentError$}
												onProcessingChange$={props.onPaymentProcessingChange$}
											/>
										) : props.srState.phase === 'paying' ? (
											<div class="payment-placeholder text-red-600" style="padding:14px 0;" role="alert">
												No payment method is configured for this store — please contact support.
											</div>
										) : (
											<div class="payment-placeholder" style="padding:14px 0;">
												{props.srState.phase === 'placing'
													? 'Preparing secure payment...'
													: 'Click PLACE ORDER to continue to secure payment.'}
											</div>
										)}
									</>
						</div>
					</div>
				</div>
				{!(props.checkoutValidation.isCustomerValid && props.checkoutValidation.isShippingAddressValid) && (
					<div class="payment-placeholder">
						Complete your shipping address to see payment options
					</div>
				)}
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
			<CheckoutDesktopCta {...props} />
		</div>
	</div>
	);
});
