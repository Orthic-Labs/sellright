import { $, component$, useOnDocument, useSignal } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { getOrders } from '~/services/customer';
import type { AccountOrderSummary } from '~/sellright/types/account';
import { formatPrice } from '~/utils';
import ShoppingBagIcon from '~/components/icons/ShoppingBagIcon';
import { formatDate, getStatusDisplay, getStatusIcon } from './order-display';
import { OrdersSkeleton } from './OrdersSkeleton';
export { head } from './seo';

const PAGE_SIZE = 20;

export default component$(() => {
	const navigate = useNavigate();
	const orders = useSignal<AccountOrderSummary[]>();
	const total = useSignal(0);
	const offset = useSignal(0);
	const loadingMore = useSignal(false);

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
									const status = getStatusDisplay(order.state, undefined);
									return (
										<a
											key={order.code}
											href={`/account/orders/${order.code}`}
											class="block bg-white rounded-[3px] border border-[#E5E0D8] hover:border-[#D8D1C7] transition-colors duration-300 overflow-hidden p-4 sm:p-6 no-underline"
										>
											<div class="flex items-start justify-between gap-4">
												<div class="flex items-center gap-3 min-w-0">
													{getStatusIcon(order.state)}
													<div class="min-w-0">
														<h3 class="text-base sm:text-lg font-semibold text-gray-900 truncate">
															Order #{order.code}
														</h3>
														<p class="text-xs sm:text-sm text-gray-500">
															{order.placedAt ? `Placed on ${formatDate(order.placedAt)}` : 'Not yet placed'}
														</p>
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
											<div class="mt-3">
												<span class={`px-2 py-1 rounded-full text-xs font-medium border ${status.color}`}>
													{status.label}
												</span>
											</div>
										</a>
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
