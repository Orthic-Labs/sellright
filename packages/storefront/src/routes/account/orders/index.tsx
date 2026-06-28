import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { OptimizedImage } from '~/components/ui';
import { Customer, Order } from '~/generated/graphql-shop';
import { getActiveCustomerOrdersQuery } from '~/providers/shop/customer/customer';
import { trackOrderServer } from '~/services/track-order.service';
import { formatPrice } from '~/utils';
import CreditCardIcon from '~/components/icons/CreditCardIcon';
import ShoppingBagIcon from '~/components/icons/ShoppingBagIcon';
import { ChevronDownIcon, formatDate, getStatusDisplay, getStatusIcon, getTrackingInfo } from './order-display';
import { OrdersSkeleton } from './OrdersSkeleton';
export { head } from './seo';

export default component$(() => {
	const navigate = useNavigate();
	const expandedOrders = useSignal<Set<string>>(new Set());

	const activeCustomerOrdersSignal = useSignal<Customer>();

	const loadOrdersWithCustomFields = $(async () => {
		const customerData = await getActiveCustomerOrdersQuery();
		if (!customerData?.orders?.items) {
			activeCustomerOrdersSignal.value = customerData;
			return;
		}

		const enrichedOrders = await Promise.all(
			customerData.orders.items.map(async (order: any) => {
				if (order.lines?.length > 0) {
					const hasCustomFields = order.lines.some((line: any) =>
						line.productVariant?.customFields !== undefined
					);

					if (!hasCustomFields && order.customer?.emailAddress) {
						try {
							const serverResult = await trackOrderServer(order.code, order.customer.emailAddress);
							if (serverResult.success && serverResult.order) {
								return serverResult.order;
							}
						} catch (err) {
							console.warn('Failed to enrich order with custom fields:', err);
						}
					}
				}
				return order;
			})
		);

		activeCustomerOrdersSignal.value = {
			...customerData,
			orders: {
				...customerData.orders,
				items: enrichedOrders
			}
		};
	});

	useOnDocument('qinit', $(async () => {
		await loadOrdersWithCustomFields();
	}));
	const toggleOrderExpansion = $((orderId: string) => {
		const newExpanded = new Set(expandedOrders.value);
		if (newExpanded.has(orderId)) {
			newExpanded.delete(orderId);
		} else {
			newExpanded.add(orderId);
		}
		expandedOrders.value = newExpanded;
	});

	return (
		<>
			{activeCustomerOrdersSignal.value ? (
				<div class="max-w-7xl mx-auto px-4 py-8">
					{(activeCustomerOrdersSignal.value?.orders?.items || []).length === 0 ? (
						<div class="text-center py-20">
							<div class="mx-auto w-40 h-40 bg-gradient-to-br from-[#F5F0E8]/50 to-[#F5F0E8]/30 rounded-full flex items-center justify-center mb-8 shadow-soft">
								<div class="text-[#965341] scale-150">
									<ShoppingBagIcon />
								</div>
							</div>
							<h3 class="text-2xl font-heading font-bold text-gray-900 mb-3">No Orders Yet</h3>
							<p class="text-gray-600 mb-8 max-w-md mx-auto leading-relaxed">
								You have not placed an order yet. Browse the collection and place your first order when you are ready.
							</p>
							<button
								onClick$={() => navigate('/')}
								class="bg-[#965341] text-white px-10 py-4 rounded-2xl hover:bg-black transition-all duration-300 font-medium cursor-pointer shadow-soft hover:shadow-medium hover:scale-105 font-heading"
							>
								Explore Collection
							</button>
						</div>
					) : (
						<div class="space-y-6">
							{(activeCustomerOrdersSignal.value?.orders?.items || []).map((order: Order) => {
								const trackingInfo = getTrackingInfo(order);
								const isExpanded = expandedOrders.value.has(order.id);

								return (
									<div
										key={order.id}
										class="bg-white rounded-[3px] border border-[#E5E0D8] hover:border-[#D8D1C7] transition-colors duration-300 overflow-hidden"
									>
										<div class="p-4 sm:p-6 border-b border-gray-100">
											<div class="block sm:hidden">
												<div class="flex items-start justify-between mb-2">
													<div class="flex items-center space-x-2 flex-1 min-w-0">
														{getStatusIcon(order.state)}
														<div class="min-w-0 flex-1">
															<h3 class="text-base font-semibold text-gray-900 truncate">
																Order #{order.code}
															</h3>
															<p class="text-xs text-gray-500">
																{formatDate(order.createdAt)}
															</p>
															{trackingInfo.hasTracking && (
																<p class="text-xs text-[#645541] font-mono">
																	Tracking: {trackingInfo.trackingCode}
																</p>
															)}
														</div>
													</div>
													<div class="text-right ml-2">
														<p class="text-lg font-semibold text-gray-900">
															{formatPrice(order.totalWithTax)}
														</p>
														<p class="text-xs text-gray-500">
															{order.lines.length} item{order.lines.length !== 1 ? 's' : ''}
														</p>
													</div>
												</div>

												<div class="flex items-center justify-between">
													<div class="flex items-center flex-wrap gap-2 flex-1">
														<span class={`px-2 py-1 rounded-full text-xs font-medium border ${getStatusDisplay(order.state, order).color}`}>
															{getStatusDisplay(order.state, order).label}
														</span>
														{trackingInfo.hasTracking && (
															<button
																data-tracking-code={trackingInfo.trackingCode || ''}
																onClick$={(e) => {
																	const code = ((e.target as HTMLElement).closest('[data-tracking-code]') as HTMLElement | null)?.dataset.trackingCode;
																	if (code) window.open(`https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${code}`, '_blank');
																}}
																class="px-2 py-1 bg-[#141210] text-[#FDFAF6] text-xs rounded-[3px] hover:opacity-90 transition-opacity cursor-pointer"
																title="Track Package"
															>
																Track
															</button>
														)}
													</div>
													<button
														data-order-id={order.id}
														onClick$={(e) => {
															const el = (e.target as HTMLElement).closest('[data-order-id]') as HTMLElement | null;
															if (el?.dataset.orderId) toggleOrderExpansion(el.dataset.orderId);
														}}
														class="p-2 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer ml-2"
														aria-label={isExpanded ? 'Collapse order details' : 'Expand order details'}
													>
														<div class={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
															<ChevronDownIcon />
														</div>
													</button>
												</div>
											</div>

											<div class="hidden sm:flex items-center justify-between">
												<div class="flex items-center space-x-4">
													<div class="flex items-center space-x-2">
														{getStatusIcon(order.state)}
														<div>
															<h3 class="text-lg font-semibold text-gray-900">
																Order #{order.code}
															</h3>
															<p class="text-sm text-gray-500">
																Placed on {formatDate(order.createdAt)}
															</p>
															{trackingInfo.hasTracking && (
																<p class="text-xs text-[#645541] font-mono">
																	Tracking: {trackingInfo.trackingCode}
																</p>
															)}
														</div>
													</div>
													<div class="flex items-center flex-wrap gap-2">
														<span class={`px-3 py-1 rounded-full text-xs font-medium border ${getStatusDisplay(order.state, order).color}`}>
															{getStatusDisplay(order.state, order).label}
														</span>
														{trackingInfo.hasTracking && (
															<button
																data-tracking-code={trackingInfo.trackingCode || ''}
																onClick$={(e) => {
																	const code = ((e.target as HTMLElement).closest('[data-tracking-code]') as HTMLElement | null)?.dataset.trackingCode;
																	if (code) window.open(`https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${code}`, '_blank');
																}}
																class="px-3 py-1 bg-[#141210] text-[#FDFAF6] text-xs rounded-[3px] hover:opacity-90 transition-opacity cursor-pointer"
																title="Track Package"
															>
																Track
															</button>
														)}
													</div>
												</div>

												<div class="flex items-center space-x-4">
													<div class="text-right">
														<p class="text-lg font-semibold text-gray-900">
															{formatPrice(order.totalWithTax)}
														</p>
														<p class="text-sm text-gray-500">
															{order.lines.length} item{order.lines.length !== 1 ? 's' : ''}
														</p>
													</div>
													<button
														data-order-id={order.id}
														onClick$={(e) => {
															const el = (e.target as HTMLElement).closest('[data-order-id]') as HTMLElement | null;
															if (el?.dataset.orderId) toggleOrderExpansion(el.dataset.orderId);
														}}
														class="p-2 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
														aria-label={isExpanded ? 'Collapse order details' : 'Expand order details'}
													>
														<div class={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
															<ChevronDownIcon />
														</div>
													</button>
												</div>
											</div>
										</div>

										{isExpanded && (
											<div class="p-4 bg-white">
												<div class="mb-4">
													<h4 class="font-medium text-gray-900 mb-2">Items</h4>
													<div class="space-y-2">
														{order.lines.map((line) => (
															<div key={line.id} class="flex items-center space-x-3 p-2 bg-white rounded-lg">
																<OptimizedImage
																	width={40}
																	height={40}
																	class="w-10 h-10 object-cover rounded-lg flex-shrink-0"
																	src={line.featuredAsset?.preview || '/asset_placeholder.webp'}
																	alt={line.productVariant?.name || 'Product'}
																	loading="lazy"
																/>
																<div class="flex-1 min-w-0">
																	<p class="font-medium text-gray-900 text-sm truncate">
																		{line.productVariant?.name}
																	</p>
																	<p class="text-xs text-gray-500">
																		Qty: {line.quantity} × {formatPrice(line.unitPriceWithTax)}
																	</p>
																	{line.productVariant?.options && line.productVariant.options.length > 0 && (
																		<p class="text-xs text-gray-400">
																			{line.productVariant.options.map(opt => opt.name).join(', ')}
																		</p>
																	)}
																	{line.productVariant?.customFields?.preOrderPrice && (
																		<div class="mt-1 space-y-1">
																			<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-[#F5F0E8] text-[#645541] border border-[#D8D1C7]">
																				Pre-Order
																			</span>
																			{line.productVariant.customFields.shipDate ? (
																				<p class="text-xs text-[#645541] font-medium">
																					Ships: {line.productVariant.customFields.shipDate}
																				</p>
																			) : (
																				<p class="text-xs text-[#645541] font-medium">
																					Ship date TBA
																				</p>
																			)}
																		</div>
																	)}
																</div>
																<div class="text-right">
																	<p class="font-medium text-gray-900 text-sm">
																		{formatPrice(line.linePriceWithTax)}
																	</p>
																</div>
															</div>
														))}
													</div>
												</div>

												<div class="mb-4">
													<div class="bg-[#F7F2EA] rounded-[3px] p-4 border border-[#E5E0D8]">
														<h4 class="font-medium text-gray-900 mb-3">Order Summary</h4>
														<div class="space-y-2">
															<div class="flex justify-between text-sm">
																<span class="text-gray-600">Subtotal</span>
																<span class="text-gray-900">{formatPrice(order.subTotalWithTax)}</span>
															</div>
															{order.discounts && order.discounts.length > 0 && order.discounts.map((discount: any) => (
																<div key={discount.description} class="flex justify-between text-sm">
																	<span class="text-[#645541]">Discount: {discount.description}</span>
																	<span class="text-[#645541]">-{formatPrice(discount.amountWithTax)}</span>
																</div>
															))}
															{order.couponCodes && order.couponCodes.length > 0 && (
																<div class="flex justify-between text-sm">
																	<span class="text-[#645541]">Coupon: {order.couponCodes.join(', ')}</span>
																	<span class="text-[#645541]">Applied</span>
																</div>
															)}
															<div class="flex justify-between text-sm">
																<span class="text-gray-600">Shipping</span>
																<span class="text-gray-900">{formatPrice(order.shippingWithTax)}</span>
															</div>
															{order.surcharges && order.surcharges.length > 0 && order.surcharges.map((surcharge: any) => (
																<div key={surcharge.description} class="flex justify-between text-sm">
																	<span class="text-gray-600">{surcharge.description}</span>
																	<span class="text-gray-900">{formatPrice(surcharge.priceWithTax)}</span>
																</div>
															))}
															<div class="border-t border-gray-300 pt-2 mt-2">
																<div class="flex justify-between">
																	<span class="font-semibold text-gray-900">Total</span>
																	<span class="font-semibold text-gray-900">{formatPrice(order.totalWithTax)}</span>
																</div>
															</div>
														</div>
													</div>
												</div>

												<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
													{order.shippingAddress && (
														<div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-[3px] p-3 h-full">
															<h5 class="font-medium text-[#141210] mb-1 flex items-center text-sm">
																<svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
																	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
																	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
																</svg>
																Shipping
															</h5>
															<p class="text-xs text-[#645541]">
																{order.shippingAddress.fullName}<br />
																{order.shippingAddress.streetLine1}<br />
																{order.shippingAddress.streetLine2 && <>{order.shippingAddress.streetLine2}<br /></>}
																{order.shippingAddress.city}, {order.shippingAddress.province} {order.shippingAddress.postalCode}<br />
																{order.shippingAddress.countryCode}
																{order.shippingAddress.phoneNumber && <><br />{order.shippingAddress.phoneNumber}</>}
															</p>
														</div>
													)}

													{order.payments && order.payments.length > 0 && (
														<div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-[3px] p-3 h-full">
															<h5 class="font-medium text-gray-900 mb-1 flex items-center text-sm">
																<CreditCardIcon />
																<span class="ml-1">Payment</span>
															</h5>
															<p class="text-xs text-gray-600">
																{order.payments[0].method.replace(/([A-Z])/g, ' $1').trim()}
															</p>
															<p class="text-xs text-gray-500">
																{formatPrice(order.payments[0].amount)}
															</p>
														</div>
													)}

													<div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-[3px] p-3 h-full">
														<h5 class="font-medium text-[#141210] mb-1 flex items-center text-sm">
															{getStatusIcon(order.state)}
															<span class="ml-1">Status</span>
														</h5>
														<p class="text-xs text-[#645541]">
															{getStatusDisplay(order.state, order).label}
														</p>
														{getStatusDisplay(order.state, order).description && (
															<p class="text-xs text-[#645541] mt-1">
																{getStatusDisplay(order.state, order).description}
															</p>
														)}
														<p class="text-xs text-[#645541]">
															Order placed on {formatDate(order.createdAt)}
														</p>
													</div>
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			) : (
				<OrdersSkeleton />
			)}
		</>
	);
});
