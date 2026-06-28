import { component$, useContext, useSignal, useStore, $, useTask$ } from '@qwik.dev/core';
import { useLocation, useNavigate } from '@qwik.dev/router';
import { APP_STATE } from '~/constants';
import { isCheckoutPage } from '~/utils/route-helpers';
import CartContents from '../cart-contents/CartContents';
import FreeShippingProgress from '../free-shipping-progress/FreeShippingProgress';
import { EligibleShippingMethods } from '~/types';
import { formatPrice } from '~/utils';
import { useLocalCart } from '~/contexts/CartContext';
import { CountryService } from '~/services/CountryService';
import { LocalCartService } from '~/services/LocalCartService';
import { getCartShippingMethod } from './cart-shipping';

export default component$(() => {
	const location = useLocation();
	const navigate = useNavigate();
	const appState = useContext(APP_STATE);
	const localCart = useLocalCart();
	const isInEditableUrl = !isCheckoutPage(location.url.toString());

	const isNavigatingToCheckout = useSignal(false);
	const countryCodeSignal = useSignal(appState.shippingAddress.countryCode);
	const panelRef = useSignal<Element>();

	// Auto-focus panel when cart opens so Escape key is captured
	useTask$(({ track }) => {
		track(() => appState.showCart);
		if (appState.showCart && typeof document !== 'undefined') {
			setTimeout(() => (panelRef.value as HTMLElement)?.focus(), 0);
		}
	});

	const dropdownState = useStore({
		pendingCountryCode: '',
		debounceTimer: null as number | null,
		DEBOUNCE_DELAY: 500
	});

	// T20: Restore country + load country list — useTask$ (runs once)
	useTask$(async () => {
		if (!appState.shippingAddress.countryCode) {
			const stored = LocalCartService.getCountry();
			appState.shippingAddress.countryCode = stored;
			countryCodeSignal.value = stored;
		} else {
			countryCodeSignal.value = appState.shippingAddress.countryCode;
		}
		if (!appState.availableCountries || appState.availableCountries.length === 0) {
			const countries = await CountryService.getAvailableCountries();
			appState.availableCountries = countries as any[];
		}
	});

	const hasOutOfStockItems = $(() => {
		const items = localCart.localCart.items;
		return items.some(
			(item: any) => item.productVariant.stockLevel === 'OUT_OF_STOCK' || item.productVariant.stockLevel <= 0
		);
	});

	const isOutOfStock = useSignal(false);

	// T20: Track out-of-stock via useTask$
	useTask$(async ({ track }) => {
		track(() => localCart.localCart.items);
		track(() => appState.activeOrder);
		isOutOfStock.value = await hasOutOfStockItems();
	});

	// T20: Sync country code signal via useTask$
	useTask$(({ track }) => {
		const countryCode = track(() => appState.shippingAddress.countryCode);
		if (countryCode && countryCode !== countryCodeSignal.value) {
			countryCodeSignal.value = countryCode;
		}
	});

	// Shipping calculation state
	const shippingState = useStore<{
		selectedMethod: EligibleShippingMethods | null;
		methods: EligibleShippingMethods[];
		isLoading: boolean;
		error: string | null;
		lastCheckedCountry: string;
	}>({
		selectedMethod: null,
		methods: [],
		isLoading: false,
		error: null,
		lastCheckedCountry: '',
	});

	// Reactive shipping calculation — drives shippingState on every track change.
	// Previously this was useResource$ which has beta.32 quirks where sync-body resources
	// skip re-runs after first resolution. Plain useTask$ is reliable.
	useTask$(({ track }) => {
		const countryCode = track(() => appState.shippingAddress.countryCode);
		const cartVisible = track(() => appState.showCart);
		const subTotal = track(() => localCart.localCart.subTotal);
		const appliedCoupon = track(() => localCart.appliedCoupon);
		const orderTotalAfterDiscount = subTotal - (appliedCoupon?.discountAmount || 0);

		if (!cartVisible || !countryCode || subTotal === 0) {
			shippingState.methods = [];
			shippingState.selectedMethod = null;
			return;
		}

		const selectedShippingMethod = getCartShippingMethod(countryCode, orderTotalAfterDiscount);

		shippingState.methods = [selectedShippingMethod];
		shippingState.selectedMethod = selectedShippingMethod;
		shippingState.lastCheckedCountry = countryCode;
		shippingState.error = null;
	});

	const calculationState = useStore({
		isCalculating: false,
		lastCalculationTime: 0,
		MIN_CALCULATION_INTERVAL: 200,
	});

	const calculateShipping = $(async (countryCode: string, orderTotalAfterDiscount: number) => {
		if (!countryCode || !orderTotalAfterDiscount) return;

		const now = Date.now();
		if (calculationState.isCalculating || (now - calculationState.lastCalculationTime < calculationState.MIN_CALCULATION_INTERVAL)) return;

		calculationState.isCalculating = true;
		calculationState.lastCalculationTime = now;
		shippingState.isLoading = true;
		shippingState.error = null;

		try {
			const selectedShippingMethod = getCartShippingMethod(countryCode, orderTotalAfterDiscount);

			shippingState.methods = [selectedShippingMethod];
			shippingState.selectedMethod = selectedShippingMethod;
			shippingState.lastCheckedCountry = countryCode;
		} catch (error: any) {
			console.error('Failed to apply shipping calculation:', error);
			shippingState.error = error.message || 'Failed to calculate shipping';
			shippingState.methods = [];
			shippingState.selectedMethod = null;
		} finally {
			shippingState.isLoading = false;
			calculationState.isCalculating = false;
		}
	});

	const handleCountryChange = $(async (countryCode: string) => {
		dropdownState.pendingCountryCode = countryCode;

		if (dropdownState.debounceTimer !== null) {
			window.clearTimeout(dropdownState.debounceTimer);
		}

		dropdownState.debounceTimer = window.setTimeout(async () => {
			const finalCountryCode = dropdownState.pendingCountryCode;

			if (finalCountryCode && finalCountryCode !== appState.shippingAddress.countryCode) {
				appState.shippingAddress.countryCode = finalCountryCode;
				countryCodeSignal.value = finalCountryCode;
				shippingState.lastCheckedCountry = '';

				const { saveUserSelectedCountry } = await import('~/utils/addressStorage');
				saveUserSelectedCountry(finalCountryCode);

				const country = appState.availableCountries.find(c => c.code === finalCountryCode);
				if (country) {
					appState.shippingAddress.country = country.name;
				}

				const subtotal = localCart.localCart.subTotal;
				const orderTotalAfterDiscount = subtotal - (localCart.appliedCoupon?.discountAmount || 0);

				if (subtotal > 0) {
					calculateShipping(finalCountryCode, orderTotalAfterDiscount);
				}
			}

			dropdownState.debounceTimer = null;
		}, dropdownState.DEBOUNCE_DELAY);
	});

	return (
		<div>
			{appState.showCart && (
				<div class="fixed inset-0 z-[9999] flex">

					<div
						class="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
						role="button"
						aria-label="Close cart"
						tabIndex={0}
						onClick$={() => (appState.showCart = false)}
						onKeyDown$={(e) => { if (e.key === 'Enter' || e.key === ' ') appState.showCart = false; }}
					/>

					<div
						ref={panelRef}
						role="dialog"
						aria-modal="true"
						aria-label="Shopping cart"
						class="relative ml-auto h-full w-[85vw] sm:w-[35vw] sm:max-w-[620px] flex flex-col bg-[#F7F2EA] shadow-[-6px_0_32px_rgba(0,0,0,0.14)]"
						tabIndex={-1}
						onKeyDown$={(e) => { if (e.key === 'Escape') appState.showCart = false; }}
					>

						{/* L8: Trust strip — overflow-hidden + whitespace-nowrap to prevent text wrapping on narrow screens */}
						<div class="flex items-center justify-center gap-3 px-4 py-2 border-b border-[#E5E0D8] bg-[#F5F2EE] shrink-0 overflow-hidden whitespace-nowrap">
							<span class="text-[10px] tracking-[0.06em] text-[#9A9288] truncate">Free Shipping $100+</span>
							<span class="w-px h-2.5 bg-[#DDD8D0] shrink-0" />
							<span class="text-[10px] tracking-[0.06em] text-[#9A9288] truncate">Ships in 1-2 business days</span>
							<span class="w-px h-2.5 bg-[#DDD8D0] shrink-0" />
							<span class="text-[10px] tracking-[0.06em] text-[#9A9288] truncate">Secure Checkout</span>
						</div>

						<div class="flex-1 overflow-y-auto overscroll-contain px-5 py-1 min-h-0">

							{localCart.isRefreshingStock && (
								<div class="my-2 px-3 py-1.5 bg-[#F0EBE3] flex items-center gap-2">
									<svg class="animate-spin h-3 w-3 text-[#8a6d4a] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
									</svg>
									<span class="text-[11px] text-[#8a6d4a]">Verifying availability...</span>
								</div>
							)}

							{localCart.localCart.totalQuantity > 0 ? (
								<CartContents />
							) : (
								<div class="flex flex-col items-center justify-center h-full min-h-[280px] text-center px-4">
									<svg class="w-10 h-10 text-[#C9C3BA] mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"/>
									</svg>
									<p class="font-heading text-[12px] tracking-[0.14em] uppercase text-[#1A1A1A] mb-1.5">Your cart is empty</p>
									<p class="text-[12px] text-[#9A9288] mb-6 leading-relaxed">Browse our collection to find something you'll love.</p>
									<button
										class="px-8 py-2.5 bg-[#1A1A1A] text-white text-[11px] tracking-[0.18em] uppercase hover:bg-[#8a6d4a] transition-colors duration-300 cursor-pointer"
										onClick$={async () => {
											appState.showCart = false;
											await navigate('/shop');
										}}
									>
										Shop Now
									</button>
								</div>
							)}
						</div>

						{/* Compact sticky footer */}
						{localCart.localCart.totalQuantity > 0 && isInEditableUrl && (
							<div class="border-t border-[#E5E0D8] bg-[#F0EBE3] px-5 pt-3 pb-4 shrink-0">

								{/* Free Shipping Progress Bar */}
								<div class="mb-2">
									<FreeShippingProgress
										countryCode={appState.shippingAddress.countryCode}
										orderTotalAfterDiscount={localCart.localCart.subTotal - (localCart.appliedCoupon?.discountAmount || 0)}
										currencyCode={localCart.localCart.currencyCode}
									/>
								</div>

								{/* M4: Removed dynamic key to prevent re-mount on country change; M8: Added aria-label for accessibility */}
								<div class="relative mb-2">
									<select
										id="country-selector"
										class="w-full appearance-none bg-white border border-[#DDD8D0] px-3 py-1.5 pr-7 text-[12px] text-[#1A1A1A] focus:outline-none focus:border-[#8a6d4a] transition-colors cursor-pointer"
										onChange$={(_, el) => handleCountryChange(el.value)}
										value={countryCodeSignal.value}
										aria-label="Country"
									>
										<option value="">Shipping destination...</option>
										{appState.availableCountries.map((country) => (
											<option
												key={country.code}
												value={country.code}
												selected={country.code === countryCodeSignal.value}
											>
												{country.name}
											</option>
										))}
									</select>
									<div class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
										<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
											<path d="M1.5 3.5l3.5 3 3.5-3" stroke="#9A9288" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
										</svg>
									</div>
								</div>

								<div class="space-y-1 mb-2">
									<div class="flex justify-between items-baseline">
										<span class="text-[11px] tracking-[0.05em] text-[#9A9288] uppercase">Subtotal</span>
										<span class="text-[13px] font-medium text-[#1A1A1A] tabular-nums">
											{formatPrice(localCart.localCart.subTotal, localCart.localCart.currencyCode)}
										</span>
									</div>

									{/* Shipping calculation result */}
									<div class="flex justify-between items-baseline">
										<span class="text-[11px] tracking-[0.05em] text-[#9A9288] uppercase">Shipping</span>
										{shippingState.selectedMethod ? (
											<span class="text-[13px] font-medium tabular-nums">
												{shippingState.selectedMethod.priceWithTax === 0
													? <span class="text-[#8a6d4a]">Free</span>
													: <span class="text-[#1A1A1A]">{formatPrice(shippingState.selectedMethod.priceWithTax, localCart.localCart.currencyCode)}</span>
												}
											</span>
										) : (
											<span class="text-[11px] text-[#C9C3BA]">
												{countryCodeSignal.value ? 'Not available' : '\u2014'}
											</span>
										)}
									</div>

									{/* Total with shipping */}
									{shippingState.selectedMethod && (
										<div class="flex justify-between items-baseline pt-1.5 border-t border-[#E5E0D8]">
											<span class="text-[11px] tracking-[0.05em] text-[#1A1A1A] uppercase font-semibold">Total</span>
											<span class="text-[15px] font-semibold text-[#1A1A1A] tabular-nums">
												{formatPrice(
													localCart.localCart.subTotal + shippingState.selectedMethod.priceWithTax,
													localCart.localCart.currencyCode
												)}
											</span>
										</div>
									)}
								</div>

								<button
									onClick$={$(async () => {
										if (isNavigatingToCheckout.value) return;
										isNavigatingToCheckout.value = true;

										try {
											if (localCart.localCart.items.length === 0) {
												console.error('No items in local cart');
												return;
											}

											if (!shippingState.selectedMethod) {
												console.error('No shipping method selected');
												return;
											}

											if (!appState.shippingAddress.countryCode) {
												console.error('No country selected');
												return;
											}

											await navigate('/checkout/');
										} catch (error) {
											console.error('Error navigating to checkout:', error);
											appState.showCart = true;
										} finally {
											isNavigatingToCheckout.value = false;
										}
									})}
									disabled={isNavigatingToCheckout.value || !shippingState.selectedMethod ||
														!appState.shippingAddress.countryCode ||
														localCart.localCart.items.length === 0 || isOutOfStock.value}
									class="w-full py-3 mb-1.5 bg-[#141210] text-[#FDFAF6] text-[11px] tracking-[0.2em] uppercase font-medium
									       hover:opacity-90 active:opacity-85
									       disabled:opacity-40 disabled:cursor-not-allowed
									       transition-opacity duration-300 cursor-pointer
									       flex items-center justify-center gap-2"
								>
									{isNavigatingToCheckout.value ? (
										<>
											<svg class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
												<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
												<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
											</svg>
											Processing...
										</>
									) : !appState.shippingAddress.countryCode ? (
										'Select a country to continue'
									) : (
										'Checkout'
									)}
								</button>

								<button
									onClick$={() => (appState.showCart = false)}
									class="w-full text-center text-[11px] tracking-[0.08em] text-[#9A9288] hover:text-[#1A1A1A] transition-colors py-1 cursor-pointer uppercase bg-transparent border-0"
								>
									Continue Shopping
								</button>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
});
