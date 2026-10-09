import { component$, useContext, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { Link, useLocation } from '@qwik.dev/router';
import { CartContextId, clearCart } from '~/contexts/CartContext';
import { getOrder, verifyGatewayPayment } from '~/providers/shop/checkout/checkout';
import type { OrderSummary, OrderAddressSnapshot } from '~/sellright/types/checkout';
import { formatPrice } from '~/utils';
import { OptimizedImage } from '~/components/ui';
import { TIMELINE, activeStepFromState, parseLineName, isOrderSettled, isOrderTerminalUnpaid, assetUrl, readOrderUntilSettled, resolveConfirmationEmail } from './confirmation-data';
import { APP_STATE } from '~/constants';
import { createSEOHead } from '~/utils/seo';
import { useStoreIdentityLoader } from '~/routes/layout';

export const head = ({ params, resolveValue }: { params: { code: string }; resolveValue: any }) => {
	const identity = resolveValue(useStoreIdentityLoader);
	return createSEOHead({
		title: 'Order Confirmation',
		description: `Thank you for your order${params?.code ? ' #' + params.code : ''} at ${identity.storeName}. View your order summary and details.`,
		noindex: true,
		identity,
	});
};

const ConfirmationPage = component$(() => {
	const loc = useLocation();
	const { code } = loc.params;
	const localCart = useContext(CartContextId);
	const appState = useContext(APP_STATE);
	const store = useStore<{
		order?: OrderSummary;
		loading: boolean;
		error?: string;
	}>({
		loading: true,
	});

	useVisibleTask$(async ({ cleanup }) => {
		// Abort in-flight reads and stop polling when the page unmounts —
		// otherwise a shopper who navigates away leaves a loop re-reading the
		// order (and writing state into a dead component) for up to ~12s.
		const ac = new AbortController();
		cleanup(() => ac.abort());
		try {
			// Receipt-token scoped read (or authed owner). The token is carried as
			// ?rt= from the placing session + the Stripe return_url.
			const rt = loc.url.searchParams.get('rt') || undefined;

			// Sezzle's hosted checkout redirects back here with `paymentAttempt`
			// (see packages/api/src/payments/session-input.ts's completeUrl) —
			// reconcile it before reading the order so its own webhook lag
			// doesn't leave the shopper looking at a stale PendingPayment state
			// any longer than necessary. A failed/late reconcile here isn't
			// fatal — the polling loop below still catches a webhook that lands
			// a moment later.
			const paymentAttempt = loc.url.searchParams.get('paymentAttempt') || undefined;
			if (paymentAttempt) {
				try {
					await verifyGatewayPayment(code, paymentAttempt, rt, ac.signal);
				} catch (error) {
					if (ac.signal.aborted) return;
					console.warn('[Confirmation] gateway verify failed (will still poll the order):', error);
				}
			}

			// Tolerate webhook lag: Stripe redirects here the instant the shopper
			// returns, but the webhook that flips the order to Paid may land a
			// moment later. Poll a few times while still PendingPayment.
			const order = await readOrderUntilSettled((signal) => getOrder(code, rt, signal), ac.signal);
			if (!order) return; // aborted — the page is gone, touch nothing
			store.order = order;

			if (isOrderSettled(order.state)) {
				// Cart already converted server-side into this order — retire the
				// local mirror. `clearCart` dispatches the cart-updated event the
				// header badge listens for.
				clearCart(localCart);
			}

			store.loading = false;
		} catch (error) {
			if (ac.signal.aborted) return;
			store.error = `Failed to load order: ${error}`;
			store.loading = false;
		}
	});

	return (
		<div class="bg-[var(--color-parchment)] min-h-screen">

			{/* ── Loading skeleton ── */}
			{store.loading && !store.error && (
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
					<svg class="w-10 h-10 mx-auto text-[var(--color-accent)] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
					</svg>
					<h1 class="font-display text-4xl text-[var(--color-ink)] mb-3" style="line-height: 1.1">Order not found</h1>
					<p class="text-[#5b5a56] text-sm mb-8">{store.error}</p>
					<Link href="/" class="inline-flex items-center text-xs tracking-[0.14em] uppercase text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
						Return home
					</Link>
				</div>
			)}

			{/* ── Cancelled / declined ── */}
			{store.order && !store.error && isOrderTerminalUnpaid(store.order.state) && (
				<div class="max-w-2xl mx-auto pt-20 pb-24 px-6 text-center">
					<svg class="w-10 h-10 mx-auto text-[var(--color-accent)] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
					</svg>
					<h1 class="font-display text-4xl text-[var(--color-ink)] mb-3" style="line-height: 1.1">
						{store.order.state === 'Cancelled' ? 'Order cancelled' : 'Payment declined'}
					</h1>
					<p class="text-[#5b5a56] text-sm mb-4">
						{store.order.state === 'Cancelled'
							? 'This order was cancelled and no charge was made.'
							: 'The payment for this order was declined. No charge was made — you can try again.'}
					</p>
					<p class="text-xs text-[#5b5a56] mb-8">
						Order code <span class="font-medium text-[var(--color-ink)]">#{code}</span>
					</p>
					<div class="flex flex-wrap gap-6 justify-center text-xs tracking-[0.14em] uppercase">
						<Link href="/contact" class="text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
							Contact support
						</Link>
						<Link href="/checkout" class="text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
							Try again
						</Link>
					</div>
				</div>
			)}

			{/* ── Confirmation ── */}
			{store.order && !store.error && !isOrderTerminalUnpaid(store.order.state) && (() => {
				const order = store.order!;
				const activeStep = activeStepFromState(order.state);
				const addr = order.shippingAddress as OrderAddressSnapshot | null | undefined;
				const fullName = addr?.fullName || '';
				const contactEmail = resolveConfirmationEmail(order, appState.customer?.emailAddress);

				return (
				<div class="max-w-3xl mx-auto pt-8 sm:pt-12 pb-24 px-6">

					{/* ── Hero ── */}
					<div class="text-center mb-12 sm:mb-14">
						<svg class="w-10 h-10 mx-auto text-[var(--color-accent)] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<circle cx="12" cy="12" r="10" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M8 12.5l2.5 2.5L16 9.5" />
						</svg>
						<h1 class="font-display text-4xl sm:text-5xl text-[var(--color-ink)] mb-3" style="line-height: 1.05">
							Thank you{fullName ? `, ${fullName.split(' ')[0]}` : ''}
						</h1>
						<p class="text-[#5b5a56] text-sm mb-1">
							Your order <span class="font-medium text-[var(--color-ink)]">#{order.code}</span> is confirmed
						</p>
						{contactEmail && (
							<p class="text-[#7a7873] text-xs">
								A confirmation is on its way to {contactEmail}
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
											<div class={`w-3 h-3 rounded-full border ${isActive ? 'bg-[var(--color-accent)] border-[var(--color-accent)]' : 'bg-[var(--color-parchment)] border-[#D8D1C7]'}`} />
											<span class={`mt-2 font-mono text-[10px] tracking-[0.08em] uppercase ${isActive ? 'text-[var(--color-ink)]' : 'text-[#9B9284]'}`}>
												{step.label}
											</span>
										</div>
										{!isLast && (
											<div class={`flex-1 h-px mx-2 mb-5 ${idx < activeStep ? 'bg-[var(--color-accent)]' : 'bg-[#D8D1C7]'}`} />
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
							{order.lines?.map((line) => {
								const { productName, variantLabel } = parseLineName(line.name);

								return (
									<li key={line.sku} class="py-4 grid grid-cols-[64px_1fr_auto] gap-4 items-center">
										<div class="w-16 h-20 overflow-hidden bg-[#EFE9DF] rounded-[2px]">
											{line.image ? (
												<OptimizedImage
													class="w-full h-full object-center object-cover"
													src={`${assetUrl(line.image)}?preset=thumb`}
													width={128}
													height={160}
													loading="lazy"
													alt={line.name}
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
											<h3 class="text-sm text-[var(--color-ink)] truncate">{productName}</h3>
											{variantLabel && (
												<p class="text-[11px] text-[#7a7873] mt-0.5 capitalize">{variantLabel}</p>
											)}
											<p class="text-[11px] text-[#7a7873] mt-0.5">Qty {line.quantity}</p>
										</div>
										<span class="text-sm font-medium text-[var(--color-ink)] tabular-nums">
											{formatPrice(line.lineTotal)}
										</span>
									</li>
								);
							})}
						</ul>

						{/* Totals */}
						<div class="border-t border-[#E5E0D8] pt-4 mt-4 space-y-2 max-w-xs ml-auto">
							<div class="flex justify-between text-xs text-[#5b5a56]">
								<span>Subtotal</span>
								<span class="tabular-nums">{formatPrice(order.subtotal)}</span>
							</div>
							{order.shippingTotal > 0 && (
								<div class="flex justify-between text-xs text-[#5b5a56]">
									<span>Shipping</span>
									<span class="tabular-nums">{formatPrice(order.shippingTotal)}</span>
								</div>
							)}
							{order.discountTotal > 0 && (
								<div class="flex justify-between text-xs text-[var(--color-accent)]">
									<span>Discount{order.promotionCode ? ` (${order.promotionCode})` : ''}</span>
									<span class="tabular-nums">-{formatPrice(order.discountTotal)}</span>
								</div>
							)}
							<div class="flex justify-between pt-3 border-t border-[#E5E0D8]">
								<span class="text-sm font-medium text-[var(--color-ink)]">Total</span>
								<span class="text-sm font-medium text-[var(--color-ink)] tabular-nums">{formatPrice(order.grandTotal)}</span>
							</div>
						</div>
					</div>

					{/* ── Details grid ── */}
					<div class="border-t border-[#E5E0D8] pt-8 grid grid-cols-1 sm:grid-cols-2 gap-8 mb-12">
						<div>
							<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Contact</h3>
							<p class="text-sm text-[var(--color-ink)]">{fullName || '—'}</p>
							{contactEmail && (
								<p class="text-xs text-[#5b5a56] mt-0.5">{contactEmail}</p>
							)}
						</div>

						{addr && (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Shipping to</h3>
								<address class="not-italic text-xs text-[#5b5a56] leading-relaxed">
									{addr.fullName && <div class="text-sm text-[var(--color-ink)]">{addr.fullName}</div>}
									<div>{addr.line1}</div>
									{addr.line2 && <div>{addr.line2}</div>}
									<div>{addr.city}{addr.province ? `, ${addr.province}` : ''} {addr.postalCode}</div>
									<div>{addr.country}</div>
									{addr.phone && <div class="mt-1 text-[#7a7873]">{addr.phone}</div>}
								</address>
							</div>
						)}

						{order.payments?.length ? (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Payment</h3>
								{order.payments.map((payment, idx) => (
									<div key={idx}>
										<p class="text-sm text-[var(--color-ink)] capitalize">{payment.method}</p>
										<p class="text-xs text-[#5b5a56] mt-0.5 capitalize">{payment.state}</p>
									</div>
								))}
							</div>
						) : null}

						{order.fulfillments?.length ? (
							<div>
								<h3 class="font-mono text-[11px] tracking-[0.14em] uppercase text-[#5b5a56] mb-2">Shipment</h3>
								{order.fulfillments.map((f, idx) => (
									<div key={idx}>
										<p class="text-sm text-[var(--color-ink)] capitalize">{f.state}</p>
										{f.trackingCode && (
											<p class="text-xs text-[#5b5a56] mt-0.5">{f.carrier ? `${f.carrier} · ` : ''}{f.trackingCode}</p>
										)}
									</div>
								))}
							</div>
						) : null}
					</div>

					{/* ── Footer ── */}
					<div class="border-t border-[#E5E0D8] pt-8 text-center">
						<Link href="/shop/" class="inline-flex items-center text-xs tracking-[0.14em] uppercase text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity">
							Continue shopping →
						</Link>
						<p class="text-[11px] text-[#7a7873] mt-5">
							Questions? <Link href="/contact" class="underline underline-offset-2 hover:text-[var(--color-ink)]">Get in touch</Link>
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
