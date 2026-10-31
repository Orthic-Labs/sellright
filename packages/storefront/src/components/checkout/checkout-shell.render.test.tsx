// ADR-0001 #412: the /checkout/ shell (SHELL_CACHE=1) paints its form in SSR beside the reserved, cart-free order summary; with the
// switch off (no marker) the summary is unchanged (its skeleton, or the L11 server read when there is one) and, since lane A (LCP), the
// form paints from SSR there too instead of a loading skeleton.
import { $, component$, useContextProvider, useSignal, useStore } from '@qwik.dev/core';
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { CartContextId, type CartContextState } from '~/contexts/CartContext';
import { CheckoutAddressProvider } from '~/contexts/CheckoutAddressContext';
import { CheckoutValidationProvider } from '~/contexts/CheckoutValidationContext';
import { LoginModalProvider } from '~/contexts/LoginModalContext';
import type { CheckoutPhase, PaymentMethod } from '~/hooks/useCheckout';
import { CHECKOUT_SHELL, type ServerCartValue } from '~/routes/checkout/summary-cart';
import { EMPTY_CART, type Cart } from '~/sellright/types/cart';
import type { ShopConfig } from '~/sellright/types/checkout';
import type { AppState } from '~/types';
import { CheckoutOrderSummary } from './CheckoutOrderSummary';
import { CheckoutPaymentPanel } from './CheckoutPaymentPanel';

vi.mock('~/routes/layout', () => ({ useStoreIdentityLoader: () => ({ value: { identity: { storeName: 'Store', policies: { payment: { label: 'Secure', sub: 'payment' }, shipping: { label: 'Free', sub: 'shipping' }, returns: { label: 'Easy', sub: 'returns' } } } } }) }));

const PRICE = 4567;
const PRICE_STRINGS = ['4567', '45.67', '$46', '$45'];
const priceFree = (text: string) => PRICE_STRINGS.filter((s) => text.includes(s));
const CART_STRINGS = ['Server Widget', 'SKU1'];
const cartFree = (text: string) => CART_STRINGS.filter((s) => text.includes(s));

const serverRead = {
	...EMPTY_CART, pricingIntent: 'checkout', quoteHash: 'qh', subtotal: PRICE, grandTotal: PRICE,
	lines: [{ sku: 'SKU1', name: 'Server Widget', productName: 'Server Widget', quantity: 1, unitPrice: PRICE, lineSubtotal: PRICE, lineDiscount: 0, lineTotal: PRICE, available: true, availableQuantity: 3, image: null }],
} as unknown as Cart;

const Page = component$<{ server: ServerCartValue; client?: Cart }>((props) => {
	const appState = useStore({
		customer: { id: CUSTOMER_NOT_DEFINED_ID, title: '', firstName: '', lastName: '', emailAddress: '', phoneNumber: '' },
		shippingAddress: { countryCode: '', streetLine1: '', streetLine2: '', city: '', province: '', postalCode: '', phoneNumber: '' },
		billingAddress: { countryCode: '', streetLine1: '', streetLine2: '', city: '', province: '', postalCode: '' },
		availableCountries: [], freeShipping: null, showCart: false,
	} as unknown as AppState);
	useContextProvider(APP_STATE, appState);
	const cartState = useStore<CartContextState>({ cart: props.client ?? EMPTY_CART, isLoading: true, lastError: null, hasLoadedOnce: false, isRefreshingStock: false, notice: null, lastKnownQuantity: null });
	useContextProvider(CartContextId, cartState);
	const pageLoading = useSignal(true);
	const serverCart = useSignal<ServerCartValue>(props.server);
	const formattedTotal = useSignal<string | null>(null);
	const entryReadDone = useSignal(false);
	const promoExpanded = useSignal(false);
	const shippingCents = useSignal<number | null>(null);
	const loyalty = useSignal(null);
	const gatewayConfirmTrigger = useSignal(0);
	const totalConfirmed = useSignal(false);
	const isOrderProcessing = useSignal(false);
	const paymentMethod = useSignal<PaymentMethod>('stripe');
	const shopConfig = useSignal<ShopConfig | null>(null);
	const stripeConfirmTrigger = useSignal(0);
	const stripePublishableKey = useSignal('');
	const chargeTotalCents = useSignal(0);
	const paymentInit = useStore({ gen: 0, key: 0, failed: false });
	const srState = useStore({ phase: 'idle' as CheckoutPhase, code: '', receiptToken: '', clientSecret: '', grandTotal: 0, shownTotal: 0 });
	const state = useStore({ loading: false, error: null as string | null });
	const ignore = $(() => {});
	return (
		<div class="checkout-columns">
			<CheckoutOrderSummary
				formattedTotal={formattedTotal} hasMixedPreOrder={{ value: false }} localCart={cartState} pageLoading={pageLoading} serverCart={serverCart}
				entryReadDone={entryReadDone} promoExpanded={promoExpanded} shippingCents={shippingCents} loyalty={loyalty}
				onRedeemToggle$={$(async () => ({ ok: true }) as never)}
			/>
			<div class="checkout-form">
				<CheckoutPaymentPanel
					checkoutState={{}} checkoutValidation={{ isCustomerValid: false, isShippingAddressValid: false, isAllValid: false }} formattedTotal={formattedTotal}
					gatewayConfirmTrigger={gatewayConfirmTrigger} totalConfirmed={totalConfirmed} isOrderProcessing={isOrderProcessing}
					onGatewaySuccess$={ignore} onPaymentInitError$={ignore} onPaymentError$={ignore} onPaymentFieldError$={ignore} onPaymentProcessingChange$={ignore}
					onPlaceOrder$={ignore} pageLoading={pageLoading} serverCart={serverCart} paymentInit={paymentInit} paymentMethod={paymentMethod}
					shopConfig={shopConfig} srState={srState} state={state} stripeConfirmTrigger={stripeConfirmTrigger}
					stripePublishableKey={stripePublishableKey} ensureOrder$={$(async () => null)} chargeTotalCents={chargeTotalCents} currency="USD"
				/>
			</div>
		</div>
	);
});

const render = async (server: ServerCartValue, client?: Cart) =>
	(await ssrRenderToDom(
		<QwikRouterMockProvider url="http://localhost/checkout/">
			<LoginModalProvider>
				<CheckoutValidationProvider>
					<CheckoutAddressProvider>
						<Page server={server} client={client} />
					</CheckoutAddressProvider>
				</CheckoutValidationProvider>
			</LoginModalProvider>
		</QwikRouterMockProvider>,
		{},
	)).document;

const FORM_FIELD = 'input[autocomplete="email"], input[type="email"]';

describe('/checkout/ shell (#412)', () => {
	it('shell: the form paints in SSR beside the reserved summary; no cart contents, no price anywhere in the document', async () => {
		const document = await render(CHECKOUT_SHELL);
		const left = document.querySelector('.checkout-left')!;
		// #412: the reserved summary is the loaded summary's own boxes: CartContents' line row with its fixed 88x112 thumbnail box,
		// and CartTotals' dark rows, so the live read replacing it moves nothing (CLS).
		const line = left.querySelector('[data-testid="checkout-shell-lines"] li')!;
		expect(line.getAttribute('class')).toContain('py-5 grid grid-cols-[88px_minmax(0,1fr)_auto] gap-4 w-full');
		expect(line.firstElementChild!.getAttribute('class')).toContain('w-[88px] h-[112px]');
		const totals = left.querySelector('[data-testid="checkout-shell-totals"]')!;
		expect(totals.getAttribute('class')).toBe('border-t mt-2 border-[rgba(var(--color-accent-rgb),0.25)] pt-4 pb-2 space-y-3');
		expect([...totals.innerHTML.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1])).toEqual(['Subtotal', 'Shipping', 'Total']);
		expect(document.querySelector(`.checkout-form ${FORM_FIELD}`)).toBeTruthy(); // the contact form, not its skeleton
		const page = document.documentElement.outerHTML; // markup and serialized state
		expect(cartFree(page)).toEqual([]);
		expect(priceFree(page)).toEqual([]);
	});

	it('switch off, no server read: the form paints in SSR (no skeleton); the summary keeps its reserved skeleton', async () => {
		const document = await render(null);
		expect(document.querySelector(`.checkout-form ${FORM_FIELD}`)).toBeTruthy();
		expect(document.querySelector('.checkout-form .mb-3 > .animate-pulse')).toBeFalsy();
		expect(document.querySelector('.checkout-left')!.innerHTML).toContain('min-height:152px');
	});

	it('switch off, L11 server read: the summary shows the cart and its total as before', async () => {
		const document = await render(serverRead);
		const summary = document.querySelector('.checkout-left')!.innerHTML;
		expect(summary).toContain('Server Widget');
		expect(summary).toContain('45.67');
		expect(document.querySelector(`.checkout-form ${FORM_FIELD}`)).toBeTruthy();
	});

	it('#412 shell: the live entry read fills the summary as soon as it lands, in the same row boxes, thumbnail at high priority', async () => {
		const client = { ...serverRead, token: 'tok', status: 'active', image: undefined } as unknown as Cart;
		const document = await render(CHECKOUT_SHELL, client);
		const left = document.querySelector('.checkout-left')!;
		expect(left.innerHTML).not.toContain('checkout-shell-lines');
		const line = left.querySelector('li')!;
		expect(line.getAttribute('class')).toContain('py-5 grid grid-cols-[88px_minmax(0,1fr)_auto] gap-4 w-full');
		expect(line.firstElementChild!.getAttribute('class')).toContain('w-[88px] h-[112px]');
		const img = line.querySelector('img')!;
		expect(img.getAttribute('fetchpriority')).toBe('high');
		expect(img.getAttribute('loading')).toBe('eager');
		expect(left.innerHTML).toContain('Server Widget');
	});

	it('switch off, L11 server read: the line thumbnail keeps its default priority (unchanged)', async () => {
		const document = await render(serverRead);
		const img = document.querySelector('.checkout-left li img')!;
		expect(img.getAttribute('fetchpriority')).toBeNull();
		expect(img.getAttribute('decoding')).toBe('async');
	});

	// Lane A (LCP 20-24 s): the heading and the form's fields are in the SSR markup AND nothing hides them until JS, hydration or a live read.
	for (const [name, server] of [['switch off, no server read', null], ['switch off, L11 server read', serverRead], ['shell', CHECKOUT_SHELL]] as const) {
		it(`${name}: the heading and the form fields paint from SSR, with no hidden/opacity-0 wrapper`, async () => {
			const document = await render(server);
			const heading = [...document.querySelectorAll('.checkout-form h3')].find((h) => h.textContent?.includes('Shipping Details'));
			expect(heading).toBeTruthy();
			const email = document.querySelector(`.checkout-form ${FORM_FIELD}`)!;
			expect(email).toBeTruthy();
			expect(document.querySelector('.checkout-form [data-testid="payment-locked"] h2')).toBeTruthy();
			for (const el of [heading!, email]) expect(hiddenAncestors(el)).toEqual([]);
		});
	}
});

/** Every ancestor (and the element) that would keep it from painting: a hiding class or an inline hiding style. */
function hiddenAncestors(el: Element): string[] {
	const found: string[] = [];
	for (let n: Element | null = el; n; n = n.parentElement) {
		const cls = ` ${n.getAttribute('class') ?? ''} `;
		const style = (n.getAttribute('style') ?? '').replace(/\s+/g, '');
		if (/ (hidden|invisible|opacity-0|sr-only) /.test(cls)) found.push(`${n.tagName}.${cls.trim()}`);
		if (/display:none|visibility:hidden|opacity:0(?![.\d])|content-visibility:hidden/.test(style)) found.push(`${n.tagName}[style=${style}]`);
		if (n.hasAttribute('hidden')) found.push(`${n.tagName}[hidden]`);
	}
	return found;
}

