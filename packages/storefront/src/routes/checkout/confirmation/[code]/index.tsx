import { component$, useContext, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { Link, useLocation } from '@qwik.dev/router';
import { APP_STATE } from '~/constants';
import { CartContextId, clearLocalCart, SERVER_CART_ENABLED } from '~/contexts/CartContext';
import { Order } from '~/generated/graphql-shop';
import { getOrderByCodeQuery, verifySezzlePaymentMutation } from '~/providers/shop/orders/order';
import { srGetOrder } from '~/utils/sellright';
import { ServerCartService } from '~/services/ServerCartService';
import { SR_CHECKOUT_ENABLED } from '~/providers/shop/checkout/checkout';

const SR_CHECKOUT_PAYMENT_LABEL = SR_CHECKOUT_ENABLED ? 'card' : 'cod';
import { formatPrice } from '~/utils';
import { OptimizedImage } from '~/components/ui';
import { TIMELINE, activeStepFromState } from './confirmation-data';
export { head } from './confirmation-data';

const ConfirmationPage = component$(() => {
	const loc = useLocation();
	const { code } = loc.params;
	const appState = useContext(APP_STATE);
	const localCart = useContext(CartContextId);
	const store = useStore<{
		order?: Order;
		loading: boolean;
		error?: string;
		sezzleVerificationFailed?: boolean;
		sezzleErrorMessage?: string;
	}>({
		loading: true,
	});

	useVisibleTask$(async () => {
		try {
			// Receipt-token scoped read (or authed owner). The token is carried as
			// ?rt= from the placing session + the Stripe return_url.
			const rt = loc.url.searchParams.get('rt') || undefined;
			// Tolerate webhook lag: Stripe redirects here the instant the card is
			// confirmed, but `payment_intent.succeeded` (→ Paid + licenses) may land a
			// moment later. Poll a few times while still PendingPayment.
			let sr = await srGetOrder(code, rt);
			for (let i = 0; i < 8 && sr.state === 'PendingPayment'; i++) {
				await new Promise((r) => setTimeout(r, 1500));
				sr = await srGetOrder(code, rt);
			}
			store.order = {
				id: sr.code, code: sr.code, state: sr.state,
				totalWithTax: sr.grandTotal, subTotal: sr.subtotal, subTotalWithTax: sr.subtotal + sr.taxTotal,
				shippingWithTax: sr.shippingTotal,
				customer: null, discounts: [], shippingLines: [],
				payments: [{ method: SR_CHECKOUT_PAYMENT_LABEL, state: sr.state === 'Paid' ? 'Settled' : 'Created', amount: sr.grandTotal }],
				shippingAddress: (sr.shippingAddress as any) || {}, billingAddress: {},
				lines: sr.lines.map((l) => ({
					id: l.sku, quantity: l.quantity, linePriceWithTax: l.lineTotal, priceWithTax: l.unitPrice,
					featuredAsset: { preview: '' }, productVariant: { name: l.name, sku: l.sku },
				})),
			} as unknown as typeof store.order;

			const sezzlePayment = store.order?.payments?.find(p => p.method === 'sezzle' && p.state === 'Authorized');
			const sezzleVerifyKey = `sezzle-verified-${code}`;
			const alreadyVerified = sessionStorage.getItem(sezzleVerifyKey);
			if (sezzlePayment && !alreadyVerified) {
				sessionStorage.setItem(sezzleVerifyKey, 'true');
				try {
					const verificationResult = await verifySezzlePaymentMutation(code);

					if (verificationResult.success) {
						store.order = await getOrderByCodeQuery(code);
					} else {
						store.sezzleVerificationFailed = true;
						store.sezzleErrorMessage = verificationResult.message || 'Payment verification failed';
						store.loading = false;
						return;
					}
				} catch (_verificationError) {
					store.sezzleVerificationFailed = true;
					store.sezzleErrorMessage = 'Unable to verify payment status. Please contact support if payment was deducted.';
					store.loading = false;
					return;
				}
			}

			if (store.order?.id) {
				const hasSuccessfulPayment = store.order?.payments?.some(
					p => p.state === 'Settled' || p.state === 'Authorized'
				);

				if (hasSuccessfulPayment) {
					appState.activeOrder = {
						...appState.activeOrder,
						id: '',
						code: '',
						lines: [],
						state: 'Completed',
						totalWithTax: 0,
						subTotal: 0,
						shippingLines: [],
						payments: []
					} as Order;

					clearLocalCart(localCart);
					// Server-authoritative cart: also retire the sr_cart mirror so the
					// header badge + cart page reflect the converted (now empty) cart.
					if (SERVER_CART_ENABLED) {
						ServerCartService.clearCart().catch((e) => console.warn('[Confirmation] ServerCart clear failed:', e));
					}
				}

				store.loading = false;
			} else {
				store.error = `Order ${code} not found`;
				store.loading = false;
			}
		} catch (error) {
			store.error = `Failed to load order: ${error}`;
			store.loading = false;
		}
	});

	return (
		<div class="bg-[#F7F2EA] min-h-screen">

			{/* ── Loading skeleton ── */}
			{store.loading && !store.error && !store.sezzleVerificationFailed && (
				<div class="max-w-3xl mx-auto pt-20 pb-24 px-6">
					<div class="text-center animate-pulse">
						<div class="h-5 w-5 bg-[#E5E0D8] rounded-full mx-auto mb-6" />
						<div class="h-10 bg-[#E5E0D8] rounded w-80 mx-auto mb-3" />
						<div class="h-3 bg-[#E5E0D8] rounded w-48 mx-auto mb-2" />
						<div class="h-3 bg-[#E5E0D8] rounded w-56 mx-auto" />
					</div>
				</div>
			)}

			{/* ── Error state ── */}
			{store.error && (
				<div class="max-w-2xl mx-auto pt-20 pb-24 px-6 text-center">
					<svg class="w-10 h-10 mx-auto text-[#B87333] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
					</svg>
					<h1 class="font-display text-4xl text-[#111110] mb-3" style="line-height: 1.1">Order not found</h1>
					<p class="text-[#5b5a56] text-sm mb-8">{store.error}</p>
					<Link href="/" class="inline-flex items-center text-xs tracking-[0.14em] uppercase text-[#111110] border-b border-[#111110] pb-0.5 hover:opacity-70 transition-opacity">
						Return home
					</Link>
				</div>
			)}

			{/* ── Sezzle verification failure ── */}
			{store.sezzleVerificationFailed && (
				<div class="max-w-2xl mx-auto pt-20 pb-24 px-6 text-center">
					<svg class="w-10 h-10 mx-auto text-[#B87333] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
					</svg>
					<h1 class="font-display text-4xl text-[#111110] mb-3" style="line-height: 1.1">Payment verification error</h1>
					<p class="text-[#5b5a56] text-sm mb-4">{store.sezzleErrorMessage}</p>
					<p class="text-xs text-[#5b5a56] mb-8">
						If payment has been deducted, please contact support with order code <span class="font-medium text-[#111110]">#{code}</span>
					</p>
					<div class="flex flex-wrap gap-6 justify-center text-xs tracking-[0.14em] uppercase">
						<button
							onClick$={() => {
								sessionStorage.removeItem(`sezzle-verified-${code}`);
								window.location.reload();
							}}
							class="text-[#111110] border-b border-[#111110] pb-0.5 hover:opacity-70 transition-opacity"
						>
							Retry verification
						</button>
						<Link href="/contact" class="text-[#111110] border-b border-[#111110] pb-0.5 hover:opacity-70 transition-opacity">
							Contact support
						</Link>
						<Link href="/checkout" class="text-[#111110] border-b border-[#111110] pb-0.5 hover:opacity-70 transition-opacity">
							Try again
						</Link>
					</div>
				</div>
			)}

			{/* ── Confirmation ── */}
			{store.order?.id && !store.error && !store.sezzleVerificationFailed && (() => {
				const activeStep = activeStepFromState(store.order.state);
				const fullName = [store.order.customer?.firstName, store.order.customer?.lastName].filter(Boolean).join(' ');
				const addr = store.order.shippingAddress;
				const billAddr = store.order.billingAddress;
				const hasBilling = !!(billAddr?.streetLine1 && (billAddr.streetLine1 !== addr?.streetLine1 || billAddr.postalCode !== addr?.postalCode));

				return (
				<div class="max-w-3xl mx-auto pt-8 sm:pt-12 pb-24 px-6">

					{/* ── Hero ── */}
					<div class="text-center mb-12 sm:mb-14">
						<svg class="w-10 h-10 mx-auto text-[#B87333] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<circle cx="12" cy="12" r="10" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M8 12.5l2.5 2.5L16 9.5" />
						</svg>
						<h1 class="font-display text-4xl sm:text-5xl text-[#111110] mb-3" style="line-height: 1.05">
							Thank you, {store.order.customer?.firstName || 'friend'}
						</h1>
						<p class="text-[#5b5a56] text-sm mb-1">
							Your order <span class="font-medium text-[#111110]">#{store.order.code}</span> is confirmed
						</p>
						{store.order.customer?.emailAddress && (
							<p class="text-[#7a7873] text-xs">
								A confirmation is on its way to {store.order.customer.emailAddress}
							</p>
						)}
					</div>

					{/* ── Timeline ── */}
					<div class="mb-12 sm:mb-14">
						<div class="flex items-center justify-between max-w-md mx-auto">
							{TIMELINE.map((step, idx) => {
								const isActive = idx <= activeStep;
								const isLast = idx === TIMELINE.length - 1;
								return (
									<div key={step.key} class={`flex items-center ${isLast ? '' : 'flex-1'}`}>
										<div class="flex flex-col items-center">
											<div class={`w-3 h-3 rounded-full border ${isActive ? 'bg-[#B87333] border-[#B87333]' : 'bg-[#F7F2EA] border-[#D8D1C7]'}`} />
											<span class={`mt-2 font-mono text-[10px] tracking-[0.08em] uppercase ${isActive ? 'text-[#111110]' : 'text-[#9B9284]'}`}>
												{step.label}
											</span>
										</div>
										{!isLast && (
											<div class={`flex-1 h-px mx-2 mb-5 ${idx < activeStep ? 'bg-[#B87333]' : 'bg-[#D8D1C7]'}`} />
										)}
									</div>
								);
							})}
						</div>
					</div>

					{/* ── Order items ── */}
					<div class="border-t border-[#E5E0D8] pt-8 mb-10">
						<h2 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-5">Your order</h2>
						<ul class="divide-y divide-[#E5E0D8]">
							{store.order.lines?.map((line) => {
								const productName = line.productVariant?.product?.name
									|| line.productVariant?.name?.split(' ').slice(0, -1).join(' ')
									|| 'Product';
								const variantName = line.productVariant?.name || '';
								const vLabel = variantName.replace(productName, '').trim().replace(/^-\s*/, '');

								return (
									<li key={line.id} class="py-4 grid grid-cols-[64px_1fr_auto] gap-4 items-center">
										<div class="w-16 h-20 overflow-hidden bg-[#EFE9DF] rounded-[2px]">
											{line.featuredAsset?.preview ? (
												<OptimizedImage
													class="w-full h-full object-center object-cover"
													src={`${line.featuredAsset.preview}?preset=thumb`}
													width={128}
													height={160}
													loading="lazy"
													alt={variantName}
												/>
											) : (
												<div class="w-full h-full flex items-center justify-center text-[#D8D1C7]">
													<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
													</svg>
												</div>
											)}
										</div>
										<div class="min-w-0">
											<h3 class="text-sm text-[#111110] truncate">{productName}</h3>
											{vLabel && (
												<p class="text-[11px] text-[#7a7873] mt-0.5 capitalize">{vLabel}</p>
											)}
											<p class="text-[11px] text-[#7a7873] mt-0.5">Qty {line.quantity}</p>
										</div>
										<span class="text-sm font-medium text-[#111110] tabular-nums">
											{formatPrice(line.linePriceWithTax)}
										</span>
									</li>
								);
							})}
						</ul>

						{/* Totals */}
						<div class="border-t border-[#E5E0D8] pt-4 mt-4 space-y-2 max-w-xs ml-auto">
							<div class="flex justify-between text-xs text-[#5b5a56]">
								<span>Subtotal</span>
								<span class="tabular-nums">{formatPrice(store.order.subTotalWithTax || store.order.subTotal || 0)}</span>
							</div>
							{store.order.shippingLines?.map((line, idx) => (
								<div key={idx} class="flex justify-between text-xs text-[#5b5a56]">
									<span>Shipping</span>
									<span class="tabular-nums">{formatPrice(line.priceWithTax)}</span>
								</div>
							))}
							{(store.order.discounts?.length ?? 0) > 0 && store.order.discounts?.map((discount, idx) => (
								<div key={idx} class="flex justify-between text-xs text-[#B87333]">
									<span>{discount.description}</span>
									<span class="tabular-nums">-{formatPrice(Math.abs(discount.amountWithTax))}</span>
								</div>
							))}
							<div class="flex justify-between pt-3 border-t border-[#E5E0D8]">
								<span class="text-sm font-medium text-[#111110]">Total</span>
								<span class="text-sm font-medium text-[#111110] tabular-nums">{formatPrice(store.order.totalWithTax || 0)}</span>
							</div>
						</div>
					</div>

					{/* ── Details grid ── */}
					<div class="border-t border-[#E5E0D8] pt-8 grid grid-cols-1 sm:grid-cols-2 gap-8 mb-12">
						<div>
							<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Contact</h3>
							<p class="text-sm text-[#111110]">{fullName || '—'}</p>
							{store.order.customer?.emailAddress && (
								<p class="text-xs text-[#5b5a56] mt-0.5">{store.order.customer.emailAddress}</p>
							)}
						</div>

						{addr && (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Shipping to</h3>
								<address class="not-italic text-xs text-[#5b5a56] leading-relaxed">
									{addr.fullName && <div class="text-sm text-[#111110]">{addr.fullName}</div>}
									<div>{addr.streetLine1}</div>
									{addr.streetLine2 && <div>{addr.streetLine2}</div>}
									<div>{addr.city}{addr.province ? `, ${addr.province}` : ''} {addr.postalCode}</div>
									<div>{addr.countryCode}</div>
									{addr.phoneNumber && <div class="mt-1 text-[#7a7873]">{addr.phoneNumber}</div>}
								</address>
							</div>
						)}

						{hasBilling && billAddr && (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Billing to</h3>
								<address class="not-italic text-xs text-[#5b5a56] leading-relaxed">
									{billAddr.fullName && <div class="text-sm text-[#111110]">{billAddr.fullName}</div>}
									<div>{billAddr.streetLine1}</div>
									{billAddr.streetLine2 && <div>{billAddr.streetLine2}</div>}
									<div>{billAddr.city}{billAddr.province ? `, ${billAddr.province}` : ''} {billAddr.postalCode}</div>
									<div>{billAddr.countryCode}</div>
								</address>
							</div>
						)}

						{store.order.shippingLines?.length ? (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Shipping method</h3>
								{store.order.shippingLines.map((line, idx) => (
									<p key={idx} class="text-sm text-[#111110]">{line.shippingMethod.name}</p>
								))}
							</div>
						) : null}

						{store.order.payments?.length ? (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Payment</h3>
								{store.order.payments.map((payment, idx) => (
									<div key={idx}>
										<p class="text-sm text-[#111110] capitalize">{payment.method}</p>
										{payment.metadata?.cardType && payment.metadata?.last4 && (
											<p class="text-xs text-[#5b5a56] mt-0.5">
												{payment.metadata.cardType} ending in {payment.metadata.last4}
											</p>
										)}
									</div>
								))}
							</div>
						) : null}
					</div>

					{/* ── Footer ── */}
					<div class="border-t border-[#E5E0D8] pt-8 text-center">
						<Link href="/shop/" class="inline-flex items-center text-xs tracking-[0.14em] uppercase text-[#111110] border-b border-[#111110] pb-0.5 hover:opacity-70 transition-opacity">
							Continue shopping →
						</Link>
						<p class="text-[11px] text-[#7a7873] mt-5">
							Questions? <Link href="/contact" class="underline underline-offset-2 hover:text-[#111110]">Get in touch</Link>
						</p>
					</div>
				</div>
				);
			})()}
		</div>
	);
});

export default component$(() => {
	return <ConfirmationPage />;
});
