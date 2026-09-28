import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import { OptimizedImage } from '~/components/ui';
import { getOrderByCode } from '~/services/customer';
import type { AccountOrderDetail } from '~/sellright/types/account';
import { formatPrice } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { formatDate, getStatusDisplay, getStatusIcon, getTrackingInfo, isPreOrder } from '../order-display';

export default component$(() => {
	const location = useLocation();
	const order = useSignal<AccountOrderDetail | null>();
	const notFound = useSignal(false);

	useOnDocument('qinit', $(async () => {
		try {
			const result = await getOrderByCode(location.params.code);
			if (result) {
				order.value = result;
			} else {
				notFound.value = true;
			}
		} catch (error) {
			console.error('Failed to load order:', error);
			notFound.value = true;
		}
	}));

	if (notFound.value) {
		return (
			<div class="max-w-3xl mx-auto px-4 py-16 text-center">
				<h2 class="text-xl font-semibold text-gray-900 mb-2">Order not found</h2>
				<p class="text-gray-600 mb-6">We couldn't find that order on your account.</p>
				<a href="/account/orders" class="text-[var(--color-accent)] underline">Back to orders</a>
			</div>
		);
	}

	const o = order.value;
	const tracking = getTrackingInfo(o?.fulfillments);
	const status = o ? getStatusDisplay(o.state, o.fulfillments) : undefined;

	return (
		<div class="max-w-6xl m-auto rounded-lg p-4 space-y-6 text-gray-900">
			<div>
				<div class="flex items-center gap-3 mb-2">
					{o && getStatusIcon(o.state, o.fulfillments)}
					<h2>
						{o ? (
							<>Order <span class="text-xl font-semibold">{o.code}</span></>
						) : (
							<div class="h-7 w-48 bg-gray-200 rounded animate-pulse" />
						)}
					</h2>
					{status && (
						<span class={`px-2 py-1 rounded-full text-xs font-medium border ${status.color}`}>
							{status.label}
						</span>
					)}
				</div>
				<p class="mb-4">
					{o ? (
						<>Placed on{' '}<span class="text-xl font-semibold">{formatDate(o.placedAt)}</span></>
					) : (
						<div class="h-6 w-64 bg-gray-200 rounded animate-pulse" />
					)}
				</p>
				{o && isPreOrder(o.lines) && (
					<p class="text-sm text-[#645541] font-medium mb-4">
						This order includes a pre-order item.
					</p>
				)}
				{tracking.hasTracking && (
					<p class="text-sm text-[#645541] font-mono mb-4">
						Tracking: {tracking.trackingCode}{tracking.carrier ? ` (${tracking.carrier})` : ''}
					</p>
				)}
				<ul class="divide-y divide-gray-200">
					{o
						? o.lines.map((line, key) => (
							<li key={key} class="py-6 flex">
								<div class="shrink-0 w-24 h-24 border border-gray-200 rounded-md overflow-hidden">
									<OptimizedImage
										width={100}
										height={100}
										class="rounded-sm object-cover max-w-max h-full"
										src={line.image || '/asset_placeholder.webp'}
										alt={line.name || 'Product image'}
										loading="lazy"
										responsive="thumbnail"
									/>
								</div>
								<div class="ml-4 flex-1 flex flex-col">
									<div class="flex justify-between text-base font-medium">
										<h3>{line.name}</h3>
										<p class="ml-4">{formatPrice(line.lineTotal, o.currency)}</p>
									</div>
									<div class="flex-1 flex items-center justify-between text-sm text-gray-600">
										<div>Qty: {line.quantity} × {formatPrice(line.unitPrice, o.currency)}</div>
										<div class="text-xs text-gray-400 font-mono">{line.sku}</div>
									</div>
									{line.isPreOrder && (
										<p class="text-xs text-[#645541] font-medium mt-1">
											{line.shipDate ? `Ships: ${line.shipDate}` : 'Ship date TBA'}
										</p>
									)}
								</div>
							</li>
						))
						: [0, 1, 2].map((i) => (
							<li key={i} class="py-6 flex">
								<div class="shrink-0 w-24 h-24 bg-gray-200 rounded-md animate-pulse" />
								<div class="ml-4 flex-1 flex flex-col space-y-3">
									<div class="flex justify-between">
										<div class="h-5 w-40 bg-gray-200 rounded animate-pulse" />
										<div class="h-5 w-16 bg-gray-200 rounded animate-pulse" />
									</div>
									<div class="flex justify-between">
										<div class="h-4 w-12 bg-gray-200 rounded animate-pulse" />
										<div class="h-4 w-16 bg-gray-200 rounded animate-pulse" />
									</div>
								</div>
							</li>
						))
					}
				</ul>
			</div>
			<dl class="border-t mt-6 border-gray-200 py-6 space-y-4">
				<div class="flex items-center justify-between">
					<dt class="text-sm">Subtotal</dt>
					<dd class="text-sm font-medium">
						{o ? formatPrice(o.subtotal, o.currency) : <div class="h-4 w-16 bg-gray-200 rounded animate-pulse" />}
					</dd>
				</div>
				<div class="flex items-center justify-between">
					<dt class="text-sm">Shipping</dt>
					<dd class="text-sm font-medium">
						{o ? formatPrice(o.shippingTotal, o.currency) : <div class="h-4 w-16 bg-gray-200 rounded animate-pulse" />}
					</dd>
				</div>
				{o && o.discountTotal > 0 && (
					<div class="flex items-center justify-between">
						<dt class="text-sm">
							Discount{o.promotionCode ? ` (${o.promotionCode})` : ''}
						</dt>
						<dd class="text-sm font-medium">-{formatPrice(o.discountTotal, o.currency)}</dd>
					</div>
				)}
				<div class="flex items-center justify-between">
					<dt class="text-sm">Tax</dt>
					<dd class="text-sm font-medium">
						{o ? formatPrice(o.taxTotal, o.currency) : <div class="h-4 w-16 bg-gray-200 rounded animate-pulse" />}
					</dd>
				</div>
				<div class="flex items-center justify-between border-t border-gray-200 pt-4">
					<dt class="text-base font-medium">Total</dt>
					<dd class="text-base font-medium">
						{o ? formatPrice(o.grandTotal, o.currency) : <div class="h-5 w-20 bg-gray-200 rounded animate-pulse" />}
					</dd>
				</div>
			</dl>
			{o?.payments && o.payments.length > 0 && (
				<div class="bg-gray-100 p-6">
					<p class="mb-2 text-gray-600 text-sm">Payment</p>
					{o.payments.map((p, i) => (
						<p key={i} class="text-sm font-medium">
							{p.method.replace(/([A-Z])/g, ' $1').trim()} — {p.state} — {formatPrice(p.amount, o.currency)}
						</p>
					))}
				</div>
			)}
			<div class="w-full bg-gray-100 p-8">
				<p class="mb-4 text-gray-600">Shipping Address</p>
				{o ? (
					o.shippingAddress ? (
						<AddressBlock address={o.shippingAddress} />
					) : (
						<p class="text-sm text-gray-500">No shipping address on file for this order.</p>
					)
				) : (
					<div class="space-y-2">
						<div class="h-5 w-36 bg-gray-200 rounded animate-pulse" />
						<div class="h-5 w-48 bg-gray-200 rounded animate-pulse" />
						<div class="h-5 w-28 bg-gray-200 rounded animate-pulse" />
						<div class="h-5 w-24 bg-gray-200 rounded animate-pulse" />
					</div>
				)}
			</div>
		</div>
	);
});

/** The API types `shippingAddress`/`billingAddress` as `unknown` (address
 *  shape isn't standardized across payment/shipping providers) — render
 *  defensively rather than assume Vendure's address field names. */
const AddressBlock = component$(({ address }: { address: unknown }) => {
	const a = (address ?? {}) as Record<string, unknown>;
	const line = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
	const parts = [
		line(a.fullName),
		line(a.line1) ?? line(a.streetLine1),
		line(a.line2) ?? line(a.streetLine2),
		[line(a.city), line(a.province), line(a.postalCode)].filter(Boolean).join(', '),
		line(a.country) ?? line(a.countryCode),
	].filter(Boolean);
	if (parts.length === 0) return <p class="text-sm text-gray-500">No address details available.</p>;
	return (
		<>
			{parts.map((p, i) => (
				<p key={i} class="text-base font-medium">{p}</p>
			))}
		</>
	);
});

export const head = ({ params }: { params: { code: string } }) => {
	return createSEOHead({
		title: `Order ${params.code}`,
		description: `View details for your order ${params.code}.`,
		noindex: true,
	});
};
