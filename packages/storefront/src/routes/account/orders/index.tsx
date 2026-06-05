import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { OptimizedImage } from '~/components/ui';
import { Customer, Order } from '~/generated/graphql-shop';
import { getActiveCustomerOrdersQuery } from '~/providers/shop/customer/customer';
import { trackOrderServer } from '~/services/track-order.service';
import { createSEOHead } from '~/utils/seo';
import { formatPrice } from '~/utils';
import CreditCardIcon from '~/components/icons/CreditCardIcon';
import ShoppingBagIcon from '~/components/icons/ShoppingBagIcon';

export default component$(() => {
	const navigate = useNavigate();
	const expandedOrders = useSignal<Set<string>>(new Set());

	// Use orders from SSR data (loaded in layout) - for now, fallback to client-side loading
	// TODO: Once layout provides orders data, use: appState.orders
	const activeCustomerOrdersSignal = useSignal<Customer>();

	// Enhanced order loading that ensures custom fields are available
	const loadOrdersWithCustomFields = $(async () => {
		const customerData = await getActiveCustomerOrdersQuery();
		if (!customerData?.orders?.items) {
			activeCustomerOrdersSignal.value = customerData;
			return;
		}

		// Check if any orders need custom field enrichment
		const enrichedOrders = await Promise.all(
			customerData.orders.items.map(async (order: any) => {
				// If order has lines but no custom fields, try to enrich with server data
				if (order.lines?.length > 0) {
					const hasCustomFields = order.lines.some((line: any) =>
						line.productVariant?.customFields !== undefined
					);

					if (!hasCustomFields && order.customer?.emailAddress) {
						// Try to get enriched data from server-side query
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

		// Update the customer data with enriched orders
		activeCustomerOrdersSignal.value = {
			...customerData,
			orders: {
				...customerData.orders,
				items: enrichedOrders
			}
		};
	});

	// T17: Load orders on qinit
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

	const TruckIcon = component$(() => (
		<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
		</svg>
	));

	const CalendarIcon = component$(() => (
		<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
		</svg>
	));
	const ChevronDownIcon = component$(() => (
		<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	));

	const PackageIcon = component$(() => (
		<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
		</svg>
	));

	// Helper function to get the latest ship date from pre-order items
	const getLatestPreOrderShipDate = (order: any) => {
		if (!order?.lines) return null;

		const preOrderDates = order.lines
			.filter((line: any) => line.productVariant?.customFields?.preOrderPrice)
			.map((line: any) => line.productVariant?.customFields?.shipDate)
			.filter((date: any) => date) // Remove null/undefined dates
			.map((date: any) => new Date(date))
			.filter((date: Date) => !isNaN(date.getTime())); // Remove invalid dates

		if (preOrderDates.length === 0) return null;

		// Return the latest (farthest) date
		const timestamps = preOrderDates.map((date: Date) => date.getTime());
		const latestTimestamp = Math.max(...timestamps);
		const latestDate = new Date(latestTimestamp);
		return latestDate;
	};

	// Helper function to format ship date for display
	const formatShipDate = (date: Date) => {
		return date.toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		});
	};

	// Helper function to get user-friendly status display (same as modal)
	const getStatusDisplay = (state: string, order?: any) => {
		// Check if this is a pre-order using the order-level flag
		if (state === 'PaymentSettled' && order?.customFields?.isPreOrder) {
			const latestShipDate = getLatestPreOrderShipDate(order);
			const shipDateText = latestShipDate
				? `Expected to ship around ${formatShipDate(latestShipDate)}`
				: 'Expected ship date to be announced';

			return {
				label: 'Pre-ordered',
				description: shipDateText,
				color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
			};
		}

		switch (state) {
			case 'PaymentSettled':
				return {
					label: 'Processing',
					color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
				};
			case 'PartiallyShipped':
				return {
					label: 'Partially Shipped',
					color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
				};
			case 'Shipped':
				return {
					label: 'Shipped',
					color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
				};
			case 'Delivered':
				return {
					label: 'Delivered',
					color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
				};
			case 'Cancelled':
				return {
					label: 'Cancelled',
					color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
				};
			case 'Refunded':
				return {
					label: 'Refunded',
					color: 'bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]'
				};
			default:
				return {
					label: 'Processing',
					color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]'
				};
		}
	};

	const getStatusIcon = (state: string) => {
		switch (state.toLowerCase()) {
			case 'shipped':
			case 'delivered':
				return <TruckIcon />;
			case 'paymentshipped':
			case 'partiallyshipped':
				return <PackageIcon />;
			default:
				return <CalendarIcon />;
		}
	};

	const formatDate = (dateString: string) => {
		try {
			const date = new Date(dateString);
			if (isNaN(date.getTime())) {
				return 'Invalid Date';
			}
			return date.toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch (_error) {
			return 'Invalid Date';
		}
	};

	const getTrackingInfo = (order: Order) => {
		if (order.fulfillments && order.fulfillments.length > 0) {
			const fulfillment = order.fulfillments.find(f => f.trackingCode);
			if (fulfillment) {
				return {
					hasTracking: true,
					trackingCode: fulfillment.trackingCode,
					state: fulfillment.state
				};
			}
		}
		return { hasTracking: false };
	};

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
										{/* Order Header - Always Visible */}
										<div class="p-4 sm:p-6 border-b border-gray-100">
											{/* Mobile Layout - Stacked */}
											<div class="block sm:hidden">
												{/* Top Row - Order Info and Price */}
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
															{/* Tracking Info Right Below Order Info */}
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

												{/* Status and Tracking Row */}
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

											{/* Desktop Layout - Horizontal */}
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

										{/* Expandable Order Content */}
										{isExpanded && (
											<div class="p-4 bg-white">
												{/* Items List - More Compact */}
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
																	{/* Show pre-order badge and ship date for pre-order items */}
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

												{/* Order Summary - Full Width */}
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

												{/* Info Boxes - Single Row Below */}
												<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
													{/* Shipping Info */}
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

													{/* Payment Info */}
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

													{/* Delivery Status */}
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
				<div class="max-w-7xl mx-auto px-4 py-8">
					<div class="mb-8">
						<div class="h-8 bg-gray-200 rounded w-1/4 mb-2 animate-pulse"></div>
						<div class="h-4 bg-gray-200 rounded w-1/2 animate-pulse"></div>
					</div>
					<div class="space-y-6">
						{[...Array(3)].map((_, i) => (
							<div key={i} class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
								<div class="p-6 border-b border-gray-100">
									<div class="flex items-center justify-between animate-pulse">
										<div class="flex items-center space-x-4">
											<div class="w-4 h-4 bg-gray-200 rounded"></div>
											<div>
												<div class="h-5 bg-gray-200 rounded w-32 mb-2"></div>
												<div class="h-3 bg-gray-200 rounded w-24"></div>
											</div>
											<div class="w-16 h-6 bg-gray-200 rounded-full"></div>
										</div>
										<div class="text-right">
											<div class="h-5 bg-gray-200 rounded w-20 mb-2"></div>
											<div class="h-3 bg-gray-200 rounded w-16"></div>
										</div>
									</div>
								</div>
								<div class="p-6">
									<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
										<div class="lg:col-span-2 space-y-3">
											{[...Array(2)].map((_, j) => (
												<div key={j} class="flex items-center space-x-4 p-3 bg-gray-50 rounded-lg animate-pulse">
													<div class="w-12 h-12 bg-gray-200 rounded-lg"></div>
													<div class="flex-1">
														<div class="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
														<div class="h-3 bg-gray-200 rounded w-1/2"></div>
													</div>
												</div>
											))}
										</div>
										<div class="space-y-4">
											<div class="bg-gray-50 rounded-lg p-4 animate-pulse">
												<div class="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
												<div class="h-3 bg-gray-200 rounded w-full mb-1"></div>
												<div class="h-3 bg-gray-200 rounded w-3/4"></div>
											</div>
										</div>
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</>
	);
});

export const head = () => {
	return createSEOHead({
		title: 'My Orders',
		description: 'View your order history and track current orders.',
		noindex: true,
	});
};
