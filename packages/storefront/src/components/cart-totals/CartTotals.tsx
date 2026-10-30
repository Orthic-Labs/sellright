import { $, component$, useSignal, useComputed$, useTask$, type Signal } from '@qwik.dev/core';

import { useCart, applyCoupon, removeCoupon, COUPON_MAX_LENGTH, type CartContextState } from '~/contexts/CartContext';
import { formatPrice } from '~/utils';
import { TrashIcon, Alert } from '~/platform/gateway';
import { LoyaltyEarnHint } from '../loyalty/LoyaltyEarnHint';
import type { Cart } from '~/sellright/types/cart';

export default component$<{
	readonly?: boolean;
	localCart?: CartContextState;
	/** Display-only cart whose amounts to show instead (checkout's server-read summary, L11). Coupon actions still use the context. */
	displayCart?: Cart;
	/** 'rows' = dark sidebar inline rows, 'default' = original style */
	promoPlacement?: 'rows' | 'default';
	promoExpandedSignal?: Signal<boolean>;
	/**
	 * Server-authoritative shipping cost in cents (from the shipping-methods
	 * quote or the checkout total). `null` = not yet known (no destination
	 * country entered) — renders a placeholder instead of a guessed number.
	 */
	serverShippingCents?: Signal<number | null> | undefined;
}>(({ readonly = false, localCart, displayCart, promoPlacement = 'default', promoExpandedSignal, serverShippingCents }) => {
	const cartState = useCart();
	const couponCodeSignal = useSignal('');
	const errorSignal = useSignal('');
	const promoExpanded = useSignal(false);

	// `localCart` is the same CartContextId singleton as `cartState` in
	// practice (a caller passing it down is just avoiding a second context
	// read) — kept as a prop for callers that already thread it through.
	const cart = useComputed$(() => displayCart ?? (localCart ?? cartState).cart);

	const coupons = useComputed$(() => cart.value.coupons ?? []);
	const subtotal = useComputed$(() => cart.value.subtotal || 0);
	const orderTotalAfterDiscount = useComputed$(() => subtotal.value - (cart.value.discountTotal || 0));

	// Server-authoritative shipping only. `undefined` = caller didn't pass a
	// quote signal → treat as 0. `null` = quote signal exists but hasn't
	// resolved yet (e.g. no destination country) → unknown, show a
	// placeholder, never a guess.
	const shipping = useComputed$(() => cart.value.quoteHash ? cart.value.shippingTotal : (serverShippingCents !== undefined ? serverShippingCents.value : null));
	const shippingKnown = useComputed$(() => shipping.value !== null);
	const total = useComputed$(() => cart.value.quoteHash ? cart.value.grandTotal : orderTotalAfterDiscount.value + (shipping.value || 0));

	const displayDiscount = useComputed$(() => cart.value.discountTotal || 0);

	const handleInput$ = $((_event: Event, element: HTMLInputElement) => {
		couponCodeSignal.value = element.value;
		errorSignal.value = '';
	});

	// Server-cart path only: the API re-prices the real cart with the code —
	// no client-side coupon math, no separate "validate" query.
	const applyCoupon$ = $(async () => {
		if (!couponCodeSignal.value) return;
		errorSignal.value = '';

		try {
			const res = await applyCoupon(cartState, couponCodeSignal.value);
			if (res.valid) {
				couponCodeSignal.value = '';
				errorSignal.value = '';
				if (promoExpandedSignal) promoExpandedSignal.value = false;
				else promoExpanded.value = false;
			} else {
				errorSignal.value = res.reason || 'Invalid or expired code';
			}
		} catch (error) {
			console.error('Error validating coupon:', error);
			errorSignal.value = 'Failed to validate coupon. Please try again.';
		}
	});

	const removeCoupon$ = $(async (code: string) => {
		await removeCoupon(cartState, code);
		errorSignal.value = '';
	});

	// The coupon error clears itself after 3 s (the previous platform's cart's behaviour); a new message restarts the timer.
	useTask$(({ track, cleanup }) => {
		const message = track(() => errorSignal.value);
		if (!message) return;
		const timer = setTimeout(() => { errorSignal.value = ''; }, 3000);
		cleanup(() => clearTimeout(timer));
	});

	const isDarkRows = promoPlacement === 'rows';
	const isPromoExpanded = useComputed$(() => promoExpandedSignal ? promoExpandedSignal.value : promoExpanded.value);
	const currencyCode = cart.value.currency || 'USD';


	// ── Dark sidebar row layout (checkout left panel) ──
	if (isDarkRows) {
		return (
			<dl class="border-t mt-2 border-[rgba(var(--color-accent-rgb),0.25)] pt-4 pb-2 space-y-3">
				<div class="flex items-center justify-between text-[12px] text-[rgba(253,250,246,0.4)]">
					<dt>Subtotal</dt>
					<dd class="font-medium text-[rgba(253,250,246,0.6)]">{formatPrice(subtotal.value, currencyCode)}</dd>
				</div>

				{coupons.value.map(coupon => (
					<div key={coupon.code} class="text-[12px] text-[rgba(253,250,246,0.6)] space-y-1">
						<div class="flex items-center justify-between gap-2">
							<dt class="inline-flex items-center gap-2 break-all">
								<span>{coupon.code}</span>
								{!readonly && <button type="button" onClick$={() => removeCoupon$(coupon.code)} title={`Remove ${coupon.code}`} class="p-1 shrink-0"><TrashIcon forcedClass="h-3.5 w-3.5" /></button>}
							</dt>
							<dd class="whitespace-nowrap">{coupon.applied ? '-' + formatPrice(coupon.appliedAmount, currencyCode) : 'Not applied'}</dd>
						</div>
						{coupon.reason && !coupon.applied && <div role="status">{coupon.reason}</div>}
						{coupon.kind === 'account_credit' && <div class="space-y-1">
							{typeof coupon.availableAmount === 'number' && <div>Available credit: {formatPrice(coupon.availableAmount, currencyCode)}</div>}
							{typeof coupon.remainingAmount === 'number' && <div>Remaining after purchase: {formatPrice(coupon.remainingAmount, currencyCode)}</div>}
						</div>}
					</div>
				))}

				{displayDiscount.value > 0 && (
					<div class="flex items-center justify-between text-[12px] text-[rgba(253,250,246,0.4)]">
						<dt class="inline-flex items-center gap-2">
							<span>Discount</span>
						</dt>
						<dd class="font-medium text-[rgba(253,250,246,0.6)]">
							{'-' + formatPrice(displayDiscount.value, currencyCode)}
						</dd>
					</div>
				)}

				{!readonly && isPromoExpanded.value && (
					<div id="checkout-promo-code-input" class="pt-1 space-y-1">
						<div class="flex items-center justify-between w-full gap-2">
							<div class="flex items-center gap-2">
								<input
									type="text"
									placeholder="Enter promo code"
									maxLength={COUPON_MAX_LENGTH}
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
						{shippingKnown.value ? (shipping.value === 0 ? 'Free' : formatPrice(shipping.value || 0, currencyCode)) : 'Calculated at next step'}
					</dd>
				</div>
				<div class="flex items-center justify-between text-[12px] text-[rgba(253,250,246,0.4)]">
					<dt>Total</dt>
					<dd class="font-medium text-[rgba(253,250,246,0.6)]">{formatPrice(total.value, currencyCode)}</dd>
				</div>
				<LoyaltyEarnHint eligibleCents={orderTotalAfterDiscount.value} serverPoints={cart.value.pointsToEarn} dark />
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
          {shippingKnown.value ? (shipping.value === 0 ? 'Free' : formatPrice(shipping.value || 0, currencyCode)) : 'Calculated at next step'}
        </dd>
      </div>

				{coupons.value.map(coupon => (
					<div key={coupon.code} class="text-sm space-y-1">
						<div class="flex items-center justify-between gap-2">
							<dt class="inline-flex items-center gap-2 break-all">
								<span>{coupon.code}</span>
								{!readonly && <button type="button" onClick$={() => removeCoupon$(coupon.code)} title={`Remove ${coupon.code}`} class="p-1 shrink-0"><TrashIcon forcedClass="h-3.5 w-3.5" /></button>}
							</dt>
							<dd class="whitespace-nowrap">{coupon.applied ? '-' + formatPrice(coupon.appliedAmount, currencyCode) : 'Not applied'}</dd>
						</div>
						{coupon.reason && !coupon.applied && <div role="status">{coupon.reason}</div>}
						{coupon.kind === 'account_credit' && <div class="space-y-1">
							{typeof coupon.availableAmount === 'number' && <div>Available credit: {formatPrice(coupon.availableAmount, currencyCode)}</div>}
							{typeof coupon.remainingAmount === 'number' && <div>Remaining after purchase: {formatPrice(coupon.remainingAmount, currencyCode)}</div>}
						</div>}
					</div>
				))}

	      {!readonly && (
        <div class="space-y-1">
          <div class="flex items-center justify-between">
              <div class="flex items-center justify-between w-full">
                <div class="flex items-center space-x-2">
                  <input
                    type="text"
                    placeholder="Enter coupon"
                    maxLength={COUPON_MAX_LENGTH}
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
			<LoyaltyEarnHint eligibleCents={orderTotalAfterDiscount.value} serverPoints={cart.value.pointsToEarn} />
		</dl>
	);
});
