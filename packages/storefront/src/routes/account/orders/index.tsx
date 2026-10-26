import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { getOrders } from '~/services/customer';
import type { AccountOrderSummary } from '~/sellright/types/account';
import { OptimizedImage } from '~/components/ui/LazyImage';
import { formatPrice } from '~/utils';
import { orderLineLabel } from '~/utils/line-label';
import { shippingDateText } from '~/utils/shipping-label';
import type { PreOrderFacts } from '~/utils/order-display';
import { OrderCardView, ShoppingBagIcon, hasView } from '~/platform/gateway';
import { ChevronDownIcon, formatDate, getStatusDisplay, getStatusIcon, listTrackingInfo, type OrderHistoryFacts } from './order-display';
import { OrdersSkeleton } from './OrdersSkeleton';
import { projectOrder } from '~/platform/controllers/project';
import { displayOrderCode } from '~/utils/order-code';
export { head } from './seo';

const PAGE_SIZE = 20;

/** A history row: the generated summary plus the #393 facts (totals, tracking, line thumbnails, pre-order). */
type OrderHistoryRow = AccountOrderSummary & OrderHistoryFacts;

// A17 mount point: a brand order card; the card markup below is the fallback.
const hasOrderCard = hasView('account.order-card');

export default component$(() => {
	const navigate = useNavigate();
	const orders = useSignal<AccountOrderSummary[]>();
	const total = useSignal(0);
	const offset = useSignal(0);
	const loadingMore = useSignal(false);
	// Order codes whose card is expanded (items + totals), as the previous platform's history page toggled per order.
	const expanded = useSignal<string[]>([]);

	const toggle = $((code: string) => {
		expanded.value = expanded.value.includes(code) ? expanded.value.filter((c) => c !== code) : [...expanded.value, code];
	});

	const loadPage = $(async (nextOffset: number) => {
		const result = await getOrders({ limit: PAGE_SIZE, offset: nextOffset });
		total.value = result.total;
		offset.value = nextOffset + result.items.length;
		orders.value = nextOffset === 0 ? result.items : [...(orders.value ?? []), ...result.items];
	});

	useOnDocument('qinit', $(async () => {
		await loadPage(0);
	}));

	const loadMore = $(async () => {
		loadingMore.value = true;
		await loadPage(offset.value);
		loadingMore.value = false;
	});

	return (
		<>
			{orders.value ? (
				<div class="max-w-7xl mx-auto px-4 py-8">
					{orders.value.length === 0 ? (
						<div class="text-center py-20">
							<div class="mx-auto w-40 h-40 bg-gradient-to-br from-[#F5F0E8]/50 to-[#F5F0E8]/30 rounded-full flex items-center justify-center mb-8 shadow-soft">
								<div class="text-[var(--color-accent)] scale-150">
									<ShoppingBagIcon />
								</div>
							</div>
							<h3 class="text-2xl font-heading font-bold text-gray-900 mb-3">No Orders Yet</h3>
							<p class="text-gray-600 mb-8 max-w-md mx-auto leading-relaxed">
								You have not placed an order yet. Browse the collection and place your first order when you are ready.
							</p>
							<button
								onClick$={() => navigate('/')}
								class="bg-[var(--color-accent)] text-white px-10 py-4 rounded-2xl hover:bg-black transition-all duration-300 font-medium cursor-pointer shadow-soft hover:shadow-medium hover:scale-105 font-heading"
							>
								Explore Collection
							</button>
						</div>
					) : (
						<>
							<div class="space-y-4">
								{orders.value.map((order) => {
									const row = order as OrderHistoryRow;
									const preOrder: PreOrderFacts | undefined = row.isPreOrder ? { isPreOrder: true, shipDate: row.shipDate, shipDateLabel: row.shipDateLabel } : undefined;
									const status = getStatusDisplay(order.state, undefined, order.fulfillmentStatus, preOrder);
									const tracking = listTrackingInfo(row);
									const items = row.items ?? [];
									const thumbs = items.filter((i) => i.image).slice(0, 4);
									const code = order.code;
									const isExpanded = expanded.value.includes(code);
									if (hasOrderCard) return <OrderCardView key={order.code} order={projectOrder(order)} href={`/account/orders/${encodeURIComponent(order.code)}`} />;
									return (
										<article
											key={order.code}
											class="bg-white rounded-[3px] border border-[#E5E0D8] hover:border-[#D8D1C7] transition-colors duration-300 overflow-hidden"
										>
											<div class="p-4 sm:p-6">
												<div class="flex items-start justify-between gap-4">
													<div class="flex items-start gap-3 min-w-0">
														{getStatusIcon(order.state, undefined, order.fulfillmentStatus)}
														<div class="min-w-0">
															<h3 class="text-base sm:text-lg font-semibold text-gray-900 truncate">
																<a href={`/account/orders/${encodeURIComponent(order.code)}`} class="no-underline hover:underline">
																	Order {displayOrderCode(order.code)}
																</a>
															</h3>
															<p class="text-xs sm:text-sm text-gray-500">
																{order.placedAt ? `Placed on ${formatDate(order.placedAt)}` : 'Not yet placed'}
															</p>
															{tracking.hasTracking && (
																<p class="text-xs text-[#645541] font-mono break-all">
																	Tracking:{' '}
																	<a href={tracking.url} target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 hover:text-[#141210]">
																		{tracking.trackingCode}
																	</a>
																</p>
															)}
														</div>
													</div>
													<div class="text-right shrink-0">
														<p class="text-lg font-semibold text-gray-900">
															{formatPrice(order.grandTotal, order.currency)}
														</p>
														<p class="text-xs text-gray-500">
															{order.lines} item{order.lines !== 1 ? 's' : ''}
														</p>
													</div>
												</div>
												<div class="mt-3 flex items-center justify-between gap-2">
													<div class="flex items-center flex-wrap gap-2">
														<span class={`px-2 py-1 rounded-full text-xs font-medium border ${status.color}`}>
															{status.label}
														</span>
														{tracking.hasTracking && (
															<a
																href={tracking.url}
																target="_blank"
																rel="noopener noreferrer"
																class="px-2 py-1 bg-[#141210] text-[#FDFAF6] text-xs rounded-[3px] hover:opacity-90 transition-opacity no-underline"
																title="Track Package"
															>
																Track
															</a>
														)}
													</div>
													{items.length > 0 && (
														<button
															type="button"
															onClick$={() => toggle(code)}
															class="p-2 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
															aria-expanded={isExpanded}
															aria-label={isExpanded ? 'Collapse order details' : 'Expand order details'}
														>
															<div class={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
																<ChevronDownIcon />
															</div>
														</button>
													)}
												</div>
												{status.description && <p class="mt-2 text-xs text-[#645541] font-medium">{status.description}</p>}
												{thumbs.length > 0 && (
													<div class="mt-3 flex items-center gap-2">
														{thumbs.map((item) => (
															<OptimizedImage
																key={item.sku}
																width={40}
																height={40}
																class="w-10 h-10 object-cover rounded-lg flex-shrink-0"
																src={item.image as string}
																alt={orderLineLabel({ productName: item.productName, variantName: item.name })}
																loading="lazy"
															/>
														))}
														{items.length > thumbs.length && <span class="text-xs text-gray-500">+{items.length - thumbs.length}</span>}
													</div>
												)}
											</div>

											{isExpanded && (
												<div class="p-4 sm:px-6 border-t border-gray-100 bg-white">
													<h4 class="font-medium text-gray-900 mb-2">Items</h4>
													<div class="space-y-2 mb-4">
														{items.map((item) => (
															<div key={item.sku} class="flex items-center gap-3 p-2">
																<OptimizedImage
																	width={40}
																	height={40}
																	class="w-10 h-10 object-cover rounded-lg flex-shrink-0"
																	src={item.image || '/asset_placeholder.webp'}
																	alt={orderLineLabel({ productName: item.productName, variantName: item.name }) || 'Product'}
																	loading="lazy"
																/>
																<div class="flex-1 min-w-0">
																	<p class="font-medium text-gray-900 text-sm truncate">{orderLineLabel({ productName: item.productName, variantName: item.name })}</p>
																	<p class="text-xs text-gray-500">Qty: {item.quantity} × {formatPrice(item.unitPrice, order.currency)}</p>
																	{item.isPreOrder && (
																		<div class="mt-1 space-y-1">
																			<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-[#F5F0E8] text-[#645541] border border-[#D8D1C7]">
																				Pre-Order
																			</span>
																			<p class="text-xs text-[#645541] font-medium">
																				{shippingDateText(item, (d) => formatDate(d)) ? `Ships: ${shippingDateText(item, (d) => formatDate(d))}` : 'Ship date TBA'}
																			</p>
																		</div>
																	)}
																</div>
																<p class="font-medium text-gray-900 text-sm">{formatPrice(item.lineTotal, order.currency)}</p>
															</div>
														))}
													</div>
													<div class="bg-[var(--color-parchment)] rounded-[3px] p-4 border border-[#E5E0D8]">
														<h4 class="font-medium text-gray-900 mb-3">Order Summary</h4>
														<div class="space-y-2 text-sm">
															<div class="flex justify-between"><span class="text-gray-600">Subtotal</span><span class="text-gray-900">{formatPrice(row.subtotal ?? 0, order.currency)}</span></div>
															{(row.discountTotal ?? 0) > 0 && (
																<div class="flex justify-between"><span class="text-[#645541]">Discount</span><span class="text-[#645541]">-{formatPrice(row.discountTotal ?? 0, order.currency)}</span></div>
															)}
															<div class="flex justify-between">
																<span class="text-gray-600">Shipping{row.shippingMethodName ? ` (${row.shippingMethodName})` : ''}</span>
																<span class="text-gray-900">{formatPrice(row.shippingTotal ?? 0, order.currency)}</span>
															</div>
															{(row.taxTotal ?? 0) > 0 && (
																<div class="flex justify-between"><span class="text-gray-600">Tax</span><span class="text-gray-900">{formatPrice(row.taxTotal ?? 0, order.currency)}</span></div>
															)}
															<div class="border-t border-gray-300 pt-2 mt-2 flex justify-between">
																<span class="font-semibold text-gray-900">Total</span>
																<span class="font-semibold text-gray-900">{formatPrice(order.grandTotal, order.currency)}</span>
															</div>
														</div>
													</div>
													<a href={`/account/orders/${encodeURIComponent(order.code)}`} class="mt-4 inline-block text-sm underline text-[var(--color-accent)]">View order details</a>
												</div>
											)}
										</article>
									);
								})}
							</div>

							{offset.value < total.value && (
								<div class="flex justify-center mt-8">
									<button
										onClick$={loadMore}
										disabled={loadingMore.value}
										class="px-6 py-3 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-[#F9F7F4] hover:border-[var(--color-accent)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
									>
										{loadingMore.value ? 'Loading…' : `Load more (${total.value - offset.value} remaining)`}
									</button>
								</div>
							)}
						</>
					)}
				</div>
			) : (
				<OrdersSkeleton />
			)}
		</>
	);
});
