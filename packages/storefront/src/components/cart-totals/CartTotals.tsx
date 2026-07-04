import { $, component$, useContext, useSignal, useComputed$, useTask$, type Signal } from '@qwik.dev/core';
import { Order } from '~/generated/graphql-shop';

import { APP_STATE } from '~/constants';
import { applyCouponCodeMutation, removeCouponCodeMutation, validateLocalCartCouponQuery } from '~/providers/shop/orders/order';
import { formatPrice } from '~/utils';
import TrashIcon from '../icons/TrashIcon';
import Alert from '../alert/Alert';
import { useLocalCart } from '~/contexts/CartContext';

export default component$<{
	order?: Order;
	readonly?: boolean;
	localCart?: any;
	/** 'rows' = dark sidebar inline rows, 'default' = original style */
	promoPlacement?: 'rows' | 'default';
	promoExpandedSignal?: Signal<boolean>;
	/**
	 * Server-authoritative shipping cost in cents (from the shipping-methods
	 * quote or the checkout total). `null` = not yet known (no destination
	 * country entered) — renders a placeholder instead of a guessed number.
	 * When omitted entirely, falls back to `activeOrder.shippingWithTax` only
	 * (legacy Vendure-order callers).
	 */
	serverShippingCents?: Signal<number | null> | undefined;
}>(({ order, readonly = false, localCart, promoPlacement = 'default', promoExpandedSignal, serverShippingCents }) => {
	const appState = useContext(APP_STATE);
	const localCartContext = useLocalCart();
	const couponCodeSignal = useSignal('');
	const errorSignal = useSignal('');
	const promoExpanded = useSignal(false);

	const activeOrder = useComputed$(() => order || appState.activeOrder);

	const activeCouponCode = useComputed$(() => {
		if (localCartContext.appliedCoupon) {
			return localCartContext.appliedCoupon.code;
		}
		return activeOrder.value?.couponCodes?.[0];
	});
	const subtotal = useComputed$(() => {
		const sub = (localCart?.localCart?.subTotal || localCart?.subTotal || activeOrder.value?.subTotalWithTax || 0);
		return sub;
	});
	const orderTotalAfterDiscount = useComputed$(() => {
		let total = subtotal.value;
		if (localCartContext.appliedCoupon) {
			total -= localCartContext.appliedCoupon.discountAmount;
		}
		if (total === 0 && activeOrder.value) {
			total = (activeOrder.value.totalWithTax || 0) - (activeOrder.value.shippingWithTax || 0);
		}
		return total;
	});

	// Server-authoritative shipping only. `undefined` = caller didn't pass a
	// quote signal (legacy Vendure-order display) → fall back to the order's
	// own shippingWithTax. `null` = quote signal exists but hasn't resolved yet
	// (e.g. no destination country) → unknown, show a placeholder, never a guess.
	const shipping = useComputed$(() => {
		if (localCartContext.appliedCoupon?.freeShipping) {
			return 0;
		}
		if (serverShippingCents !== undefined) {
			return serverShippingCents.value;
		}
		return activeOrder.value?.shippingWithTax || 0;
	});
	const shippingKnown = useComputed$(() => shipping.value !== null);
	const total = useComputed$(() => {
		const shippingAmount = shipping.value || 0;
		const localTotal = orderTotalAfterDiscount.value + shippingAmount;
		const tot = localTotal || activeOrder.value?.totalWithTax || 0;
		return tot;
	});

	const displayDiscount = useComputed$(() => {
		if (localCartContext.appliedCoupon) {
			return localCartContext.appliedCoupon.discountAmount;
		}
		if (activeOrder.value?.discounts && activeOrder.value.discounts.length > 0) {
			const discount = activeOrder.value.discounts[0].amountWithTax || 0;
			return discount;
		}
		return 0;
	});

	const handleInput$ = $((_event: Event, element: HTMLInputElement) => {
		couponCodeSignal.value = element.value;
		errorSignal.value = '';
	});

	const applyCoupon$ = $(async () => {
		if (!couponCodeSignal.value) return;
		errorSignal.value = '';

		if (localCartContext.localCart.items.length > 0 || !order) {
			try {
				const cartItems = localCartContext.localCart.items.map(item => ({
					productVariantId: item.productVariantId,
					quantity: item.quantity,
					unitPrice: item.productVariant.price
				}));

				const result = await validateLocalCartCouponQuery({
					couponCode: couponCodeSignal.value,
					cartTotal: localCartContext.localCart.subTotal,
					cartItems,
					customerId: appState.customer?.id
				});

				if (result.isValid) {
					localCartContext.appliedCoupon = {
						code: result.appliedCouponCode || couponCodeSignal.value,
						discountAmount: result.discountAmount,
						discountPercentage: result.discountPercentage,
						freeShipping: result.freeShipping,
						promotionName: result.promotionName,
						promotionDescription: result.promotionDescription
					};
					couponCodeSignal.value = '';
					errorSignal.value = '';
					if (promoExpandedSignal) {
						promoExpandedSignal.value = false;
					} else {
						promoExpanded.value = false;
					}
				} else {
					errorSignal.value = result.validationErrors.join(', ');
				}
			} catch (error) {
				console.error('Error validating coupon:', error);
				errorSignal.value = 'Failed to validate coupon. Please try again.';
			}
			return;
		}

		const res = await applyCouponCodeMutation(couponCodeSignal.value);
		if (res.__typename === 'Order') {
			appState.activeOrder = res as Order;
			couponCodeSignal.value = '';
		} else {
			errorSignal.value = res.message;
		}
	});

	const removeCoupon$ = $(async (code: string) => {
		if (localCartContext.localCart.items.length > 0 || !order) {
			localCartContext.appliedCoupon = null;
			errorSignal.value = '';
			return;
		}

		const res = await removeCouponCodeMutation(code);
		if (res && res.__typename === 'Order') {
			appState.activeOrder = res as Order;
			errorSignal.value = '';
		}
	});

	// T29: Error auto-clear via useTask$
	useTask$(({ track, cleanup }) => {
		track(() => errorSignal.value);
		if (errorSignal.value) {
			const timer = setTimeout(() => {
				errorSignal.value = '';
			}, 3000);
			cleanup(() => clearTimeout(timer));
		}
	});

	// T29: Coupon re-validation via useTask$
	useTask$(async ({ track }) => {
		track(() => localCartContext.localCart.items);
		track(() => localCartContext.localCart.subTotal);

		if (localCartContext.appliedCoupon) {
			try {
				const cartItems = localCartContext.localCart.items.map(item => ({
					productVariantId: item.productVariantId,
					quantity: item.quantity,
					unitPrice: item.productVariant.price
				}));

				const result = await validateLocalCartCouponQuery({
					couponCode: localCartContext.appliedCoupon.code,
					cartTotal: localCartContext.localCart.subTotal,
					cartItems,
					customerId: appState.customer?.id
				});

				if (result.isValid) {
					localCartContext.appliedCoupon = {
						code: result.appliedCouponCode || localCartContext.appliedCoupon.code,
						discountAmount: result.discountAmount,
						discountPercentage: result.discountPercentage,
						freeShipping: result.freeShipping,
						promotionName: result.promotionName,
						promotionDescription: result.promotionDescription
					};
				} else {
					errorSignal.value = result.validationErrors.join(', ');
					localCartContext.appliedCoupon = null;
				}
			} catch (error) {
				console.error('Error re-validating coupon:', error);
				errorSignal.value = 'Failed to re-validate coupon.';
				localCartContext.appliedCoupon = null;
			}
		}
	});

	const isDarkRows = promoPlacement === 'rows';
	const isPromoExpanded = promoExpandedSignal ? promoExpandedSignal.value : promoExpanded.value;
	const currencyCode = localCart?.currencyCode || activeOrder.value?.currencyCode || 'USD';

	// ── Dark sidebar row layout (checkout left panel) ──
	if (isDarkRows) {
		return (
			<dl class="border-t mt-2 border-[rgba(184,115,51,0.25)] pt-4 pb-2 space-y-3">
				<div class="flex items-center justify-between text-[12px] text-[rgba(253,250,246,0.4)]">
					<dt>Subtotal</dt>
					<dd class="font-medium text-[rgba(253,250,246,0.6)]">{formatPrice(subtotal.value, currencyCode)}</dd>
				</div>

				{displayDiscount.value > 0 && (
					<div class="flex items-center justify-between text-[12px] text-[rgba(253,250,246,0.4)]">
						<dt class="inline-flex items-center gap-2">
							<span>Discount</span>
							{activeCouponCode.value && !readonly && (
								<button
									onClick$={() => removeCoupon$(activeCouponCode.value!)}
									title="Remove coupon"
									class="p-0.5 text-[rgba(253,250,246,0.48)] hover:text-[rgba(253,250,246,0.8)] transition-colors cursor-pointer bg-transparent border-0"
								>
									<TrashIcon forcedClass="h-3.5 w-3.5" />
								</button>
							)}
						</dt>
						<dd class="font-medium text-[rgba(253,250,246,0.6)]">
							{'-' + formatPrice(displayDiscount.value, currencyCode)}
						</dd>
					</div>
				)}

				{!readonly && !activeCouponCode.value && isPromoExpanded && (
					<div id="checkout-promo-code-input" class="pt-1 space-y-1">
						<div class="flex items-center justify-between w-full gap-2">
							<div class="flex items-center gap-2">
								<input
									type="text"
									placeholder="Enter promo code"
									value={couponCodeSignal.value}
									onInput$={handleInput$}
									onKeyDown$={async (event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											if (couponCodeSignal.value.length > 0) {
												await applyCoupon$();
											}
										}
									}}
									class="w-40 md:w-40 h-[40px] px-3 text-[14px] text-[rgba(253,250,246,0.7)] rounded-md border border-[rgba(253,250,246,0.2)] bg-[#141210] placeholder:text-[rgba(253,250,246,0.45)] focus:ring-1 focus:ring-[rgba(253,250,246,0.3)] focus:border-[rgba(253,250,246,0.3)] outline-hidden"
								/>
								<button
									onClick$={applyCoupon$}
									class="px-3 h-[40px] rounded-md flex-shrink-0 whitespace-nowrap bg-[#FDFAF6] hover:bg-white text-[#141210] text-[12px] font-medium transition-all duration-300 cursor-pointer border border-transparent flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
									disabled={couponCodeSignal.value.length === 0}
								>
									Apply
								</button>
							</div>
							{couponCodeSignal.value.length > 0 && (
								<button
									onClick$={() => {
										if (promoExpandedSignal) {
											promoExpandedSignal.value = false;
										} else {
											promoExpanded.value = false;
										}
										couponCodeSignal.value = '';
										errorSignal.value = '';
									}}
									class="text-[12px] text-[rgba(253,250,246,0.45)] hover:text-[rgba(253,250,246,0.75)] transition-colors cursor-pointer bg-transparent border-0"
								>
									Cancel
								</button>
							)}
						</div>
						{errorSignal.value && (
							<div class="text-right mt-1">
								<Alert message={errorSignal.value} />
							</div>
						)}
					</div>
				)}

				<div class="flex items-center justify-between text-[12px] text-[rgba(253,250,246,0.4)]">
					<dt>Shipping</dt>
					<dd class="font-medium text-[rgba(253,250,246,0.6)]">
						{shippingKnown.value ? formatPrice(shipping.value || 0, currencyCode) : 'Calculated at next step'}
					</dd>
				</div>
			</dl>
		);
	}

	// ── Default layout (original style) ──
	return (
		<dl class="border-t mt-6 border-gray-200 py-6 space-y-4">
      <div class="flex items-center justify-between">
        <dt>Subtotal</dt>
        <dd class="font-medium text-gray-900">{formatPrice(subtotal.value, currencyCode)}</dd>
      </div>

      <div class="flex items-center justify-between">
        <dt>Shipping fee</dt>
        <dd class="font-medium text-gray-900">
          {shippingKnown.value ? formatPrice(shipping.value || 0, currencyCode) : 'Calculated at next step'}
        </dd>
      </div>

      {!readonly && (
        <div class="space-y-1">
          <div class="flex items-center justify-between">
            {activeCouponCode.value ? (
              <div class="flex items-center justify-between w-full">
                <div class="flex items-center">
                  <span>{activeCouponCode.value}</span>
                  <button
                    onClick$={() => removeCoupon$(activeCouponCode.value!)}
                    title="Remove coupon"
                    class="p-1 ml-2"
                  >
                    <TrashIcon forcedClass="h-4 w-4 text-red-500 hover:text-red-700" />
                  </button>
                </div>
                <dd class="font-medium text-green-600 whitespace-nowrap">
                  {displayDiscount.value > 0
                    ? '-' + formatPrice(displayDiscount.value, currencyCode)
                    : '-' + formatPrice(0, currencyCode)}
                </dd>
              </div>
            ) : (
              <div class="flex items-center justify-between w-full">
                <div class="flex items-center space-x-2">
                  <input
                    type="text"
                    placeholder="Enter coupon"
                    value={couponCodeSignal.value}
                    onInput$={handleInput$}
                    onKeyDown$={async (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (couponCodeSignal.value.length > 0) {
                          await applyCoupon$();
                        }
                      }
                    }}
                    class="w-40 py-1 px-2 border border-gray-300 rounded-sm focus:ring-1 focus:ring-primary-500 focus:border-primary-500 outline-hidden"
                  />
                  <button
                    onClick$={applyCoupon$}
                    class="btn-primary px-3 py-1 rounded-sm"
                    disabled={couponCodeSignal.value.length === 0}
                  >
                    Apply
                  </button>
                </div>
                <dd class="font-medium text-primary-600 whitespace-nowrap">
                  {displayDiscount.value > 0
                    ? '-' + formatPrice(displayDiscount.value, currencyCode)
                    : '-' + formatPrice(0, currencyCode)}
                </dd>
              </div>
            )}
          </div>
          {errorSignal.value && (
            <div class="text-right mt-1">
             <Alert message={errorSignal.value} />
            </div>
          )}
        </div>
      )}
      <div class="flex items-center justify-between border-t border-gray-200 pt-6">
				<dt class="font-medium">Total</dt>
				<dd class="font-medium text-gray-900">{formatPrice(total.value, currencyCode)}</dd>
			</div>
		</dl>
	);
});
