import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useLocation } from '@qwik.dev/router';
import { OptimizedImage } from '~/components/ui';
import { Order } from '~/generated/graphql-shop';
import { getAccountOrderByCodeQuery } from '~/providers/shop/customer/customer';
import { formatDateTime, formatPrice } from '~/utils';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
	const location = useLocation();
	const order = useSignal<Order | undefined>(undefined);
	const loading = useSignal(true);

	// T17: Load order on qinit
	useOnDocument('qinit', $(async () => {
		try {
			const result = await getAccountOrderByCodeQuery(location.params.code);
			order.value = result || undefined;
		} catch (error) {
			console.error('Failed to load order:', error);
		} finally {
			loading.value = false;
		}
	}));

	return (
		<div class="max-w-6xl m-auto rounded-lg p-4 space-y-4 text-gray-900">
			<div>
				<h2 class="mb-2">
					{order.value ? (
						<>Order <span class="text-xl font-semibold">{order.value.code}</span></>
					) : (
						<div class="h-7 w-48 bg-gray-200 rounded animate-pulse" />
					)}
				</h2>
				<p class="mb-4">
					{order.value ? (
						<>Placed on{' '}<span class="text-xl font-semibold">{formatDateTime(order.value.createdAt)}</span></>
					) : (
						<div class="h-6 w-64 bg-gray-200 rounded animate-pulse" />
					)}
				</p>
				<ul class="divide-y divide-gray-200">
					{order.value
						? order.value.lines.map((line, key) => (
							<li key={key} class="py-6 flex">
								<div class="shrink-0 w-24 h-24 border border-gray-200 rounded-md overflow-hidden">
									<OptimizedImage
										width={100}
										height={100}
										class="rounded-sm object-cover max-w-max h-full"
										src={line.featuredAsset?.preview || '/asset_placeholder.webp'}
										alt={line.productVariant.name || 'Product image'}
										loading="lazy"
										responsive="thumbnail"
									/>
								</div>
								<div class="ml-4 flex-1 flex flex-col">
									<div>
										<div class="flex justify-between text-base font-medium">
											<h3>{line.productVariant.name}</h3>
											<p class="ml-4">
												{formatPrice(line.productVariant.price)}
											</p>
										</div>
									</div>
									<div class="flex-1 flex items-center justify-between text-sm text-gray-600">
										<div class="flex space-x-4">
											<div class="qty">1</div>
										</div>
										<div class="total">
											<div>
												{formatPrice(line.productVariant.price * line.quantity)}
											</div>
										</div>
									</div>
								</div>
							</li>
						))
						: loading.value && [0, 1, 2].map((i) => (
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
			<dl class="border-t mt-6 border-gray-200 py-6 space-y-6">
				<div class="flex items-center justify-between">
					<dt class="text-sm">Subtotal</dt>
					<dd class="text-sm font-medium">
						{order.value ? formatPrice(order.value.subTotal) : (
							<div class="h-4 w-16 bg-gray-200 rounded animate-pulse" />
						)}
					</dd>
				</div>
				<div class="flex items-center justify-between">
					<dt class="text-sm">
						Shipping{' '}
						<span class="text-gray-600">
							(<span>Standard Shipping</span>)
						</span>
					</dt>
					<dd class="text-sm font-medium">
						{order.value ? formatPrice(order.value.shippingWithTax) : (
							<div class="h-4 w-16 bg-gray-200 rounded animate-pulse" />
						)}
					</dd>
				</div>
				<div class="flex items-center justify-between border-t border-gray-200 pt-6">
					<dt class="text-base font-medium">Total</dt>
					<dd class="text-base font-medium">
						{order.value ? formatPrice(order.value.totalWithTax) : (
							<div class="h-5 w-20 bg-gray-200 rounded animate-pulse" />
						)}
					</dd>
				</div>
			</dl>
			<div class="w-full bg-gray-100 p-8">
				<p class="mb-4 text-gray-600">Shipping Address</p>
				{order.value ? (
					<>
						<p class="text-base font-medium">{order.value.shippingAddress?.fullName}</p>
						<p class="text-base font-medium">{order.value.shippingAddress?.streetLine1}</p>
						<p class="text-base font-medium">{order.value.shippingAddress?.city}</p>
						<p class="text-base font-medium">{order.value.shippingAddress?.province}</p>
					</>
				) : loading.value && (
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

export const head = ({ params }: { params: { code: string } }) => {
	return createSEOHead({
		title: `Order ${params.code}`,
		description: `View details for your order ${params.code}.`,
		noindex: true,
	});
};
