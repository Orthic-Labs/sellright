import { component$, useContext, useSignal, useTask$, $ } from '@qwik.dev/core';
import { Link, useLocation } from '@qwik.dev/router';
import { OptimizedImage, QuantityDropdown } from '~/components/ui';
import { APP_STATE } from '~/constants';
import { Order } from '~/generated/graphql-shop';

import { getProductBySlug } from '~/providers/shop/products/products';
import { formatPrice } from '~/utils';
import { isCheckoutPage } from '~/utils/route-helpers';
import { isImageCached } from '~/utils/image-cache';
import Price from '../products/Price';
import TrashIcon from '../icons/TrashIcon';
import { useLocalCart, updateLocalCartQuantity, removeFromLocalCart } from '~/contexts/CartContext';
import { LocalCartService } from '~/services/LocalCartService';
import { StockWarning } from '../cart/StockWarning';

// Image preloading function for cart product links
const handleProductLinkClick = $((productSlug: string, featuredAssetPreview?: string) => {
	const targetImageUrl = featuredAssetPreview ? featuredAssetPreview.replace('?preset=thumb', '?preset=xl') : '/asset_placeholder.webp';
	isImageCached(targetImageUrl).then((cached) => {
		if (!cached) {
			const img = new Image();
			img.src = targetImageUrl;
		}
	});
});

export default component$<{
	order?: Order;
}>(({ order }) => {

	const location = useLocation();
	const appState = useContext(APP_STATE);
	const localCart = useLocalCart();
	const currentOrderLineSignal = useSignal<{ id: string; value: number }>();
	const isCheckoutView = isCheckoutPage(location.url.toString());
	const isInEditableUrl = !isCheckoutView || !order;
	const isOrderConfirmation = !!order;
	const currencyCode = order?.currencyCode || appState.activeOrder?.currencyCode || 'USD';

	const productNameCache = useSignal<Record<string, string>>({});
	const quantityOptionsCache = useSignal<Record<string, (number | string)[]>>({});
	const expandedDropdowns = useSignal<Set<string>>(new Set());
	const processedLineIds = useSignal<Set<string>>(new Set());

	// Component-level handlers — avoid .map() params crossing $() boundary
	const handleRemoveItem$ = $((e: Event) => {
		const btn = (e.target as HTMLElement).closest('[data-variant-id]') as HTMLElement;
		if (!btn) return;
		const variantId = btn.dataset.variantId!;
		removeFromLocalCart(localCart, variantId).then(() => {
			if (localCart.localCart.items.length === 0) {
				appState.showCart = false;
			}
		}).catch(() => {});
	});

	const handleLinkClick$ = $((e: Event) => {
		const el = (e.target as HTMLElement).closest('[data-slug]') as HTMLElement;
		if (!el) return;
		handleProductLinkClick(el.dataset.slug!, el.dataset.preview || undefined);
	});

	const handleStockRemove$ = $((variantId: string) => {
		removeFromLocalCart(localCart, variantId);
	});

	const handleQtyChange$ = $((value: number | string, id: string) => {
		const variantId = id.replace('quantity-', '');
		if (value === '10+') {
			expandedDropdowns.value = new Set([...expandedDropdowns.value, variantId]);
		} else {
			currentOrderLineSignal.value = { id: variantId, value: +value };
		}
	});

	useTask$(({ track, cleanup }) => {
		track(() => currentOrderLineSignal.value);
		let id: NodeJS.Timeout;
		if (currentOrderLineSignal.value) {
			id = setTimeout(async () => {
				try {
					await updateLocalCartQuantity(
						localCart,
						currentOrderLineSignal.value!.id,
						currentOrderLineSignal.value!.value
					);
				} catch (_error) {
					// silent
				}
			}, 300);
		}
		cleanup(() => {
			if (id) {
				clearTimeout(id);
			}
		});
	});

	// T23: Replace UVT with useTask$ for reactive cart tracking
	useTask$(async ({ track }) => {
		const _cartItems = track(() => localCart.localCart.items);

		const lines = order?.lines || appState.activeOrder?.lines || [];

		for (const line of lines) {
			if (processedLineIds.value.has(line.id)) continue;
			processedLineIds.value = new Set([...processedLineIds.value, line.id]);

			const stockLevel = '3';
			let maxQty = 3;
			const numericStock = parseInt(stockLevel, 10);
			if (!isNaN(numericStock)) {
				maxQty = Math.max(numericStock, line.quantity);
			}

			const isExpanded = expandedDropdowns.value.has(line.id);
			let options: (number | string)[];
			if (maxQty <= 10) {
				options = Array.from({length: maxQty}, (_, i) => i + 1);
			} else if (!isExpanded) {
				options = [...Array.from({length: 9}, (_, i) => i + 1), "10+"];
			} else {
				options = Array.from({length: maxQty}, (_, i) => i + 1);
			}

			quantityOptionsCache.value = {
				...quantityOptionsCache.value,
				[line.id]: options
			};

			if (line.productVariant?.product?.slug && !line.productVariant.product.name) {
				const slug = line.productVariant.product?.slug;
				if (!slug) continue;
				if (!productNameCache.value[slug]) {
					try {
						const product = await getProductBySlug(slug);
						if (product && product.name) {
							productNameCache.value = {
								...productNameCache.value,
								[slug]: product.name
							};
						}
					} catch (error) {
						console.error(`Error fetching product details for slug ${slug}:`, error);
					}
				}
			}
		}
	});

	// Helper: strip product name prefix from variant name
	const variantLabel = (variantName: string, productName: string) => {
		const stripped = variantName.replace(productName, '').trim();
		return stripped.startsWith('-') ? stripped.substring(1).trim() : stripped;
	};

	// Helper: derive quantity options for local cart items
	const qtyOptions = (stockLevel: string, currentQty: number, variantId: string) => {
		const numeric = parseInt(stockLevel, 10);
		const maxQty = isNaN(numeric) ? currentQty : Math.max(numeric, currentQty);
		const expanded = expandedDropdowns.value.has(variantId);
		if (maxQty <= 10) return Array.from({ length: maxQty }, (_, i) => i + 1);
		return expanded
			? Array.from({ length: maxQty }, (_, i) => i + 1)
			: [...Array.from({ length: 9 }, (_, i) => i + 1), '10+'];
	};

	return (
		<div class="flow-root w-full">
			<ul class={`divide-y w-full ${isCheckoutView ? 'divide-[rgba(184,115,51,0.25)]' : 'divide-[rgba(17,17,17,0.08)]'}`}>
				{/* Render local cart items when in local mode */}
				{localCart.localCart.items.map((item) => {
					const productSlug = item.productVariant.product?.slug || '';
					const productName = item.productVariant.product?.name ||
						productNameCache.value[productSlug] ||
						productSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

					const linePrice = LocalCartService.lineUnitPrice(item) * item.quantity;
					const stockNum = parseInt(item.productVariant.stockLevel || '0');
					const isOOS = stockNum <= 0;
					const quantityOpts = qtyOptions(item.productVariant.stockLevel || '3', item.quantity, item.productVariantId);
					const vLabel = variantLabel(item.productVariant.name, productName);

					return (
						<li key={item.productVariantId} class="py-5 grid grid-cols-[88px_minmax(0,1fr)_auto] gap-4 w-full">
							{/* Image — square crop, no border radius for editorial feel */}
							<div class={`shrink-0 w-[88px] h-[112px] overflow-hidden ${isCheckoutView ? 'bg-[rgba(253,250,246,0.06)]' : 'bg-[rgba(17,17,17,0.04)]'}`}>
								<OptimizedImage
									class="w-full h-full object-center object-cover"
									src={item.productVariant.featuredAsset?.preview || '/asset_placeholder.webp'}
									width={160}
									height={200}
									loading="lazy"
									responsive="thumbnail"
									alt={`Image of: ${item.productVariant.name}`}
								/>
							</div>

							{/* Product Details */}
							<div class="flex flex-col justify-between min-w-0">
								<div class="min-w-0">
									<h3 class={`text-[15px] font-normal leading-snug truncate font-heading ${isCheckoutView ? 'text-[#FDFAF6]' : 'text-[#1A1A1A]'}`}>
										{productSlug ? (
											<Link
												href={`/products/${productSlug}/`}
												data-slug={productSlug}
								data-preview={item.productVariant.featuredAsset?.preview || ''}
								onClick$={handleLinkClick$}
											>
												{productName}
											</Link>
										) : (
											<span>{productName}</span>
										)}
									</h3>
									{vLabel && (
										<p class={`text-[11px] mt-0.5 capitalize tracking-wide ${isCheckoutView ? 'text-[rgba(253,250,246,0.48)]' : 'text-[rgba(26,26,26,0.5)]'}`}>
											{vLabel}
										</p>
									)}
									{(item as any).isPreOrder && (
										<span class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-[1.5px] uppercase font-heading mt-1 border border-[#965341]/30 text-[#965341] bg-[#965341]/5">
											Pre-order
											{(item as any).shipDate && (
												<span class="text-[#8a6d4a]">· Ships {(item as any).shipDate}</span>
											)}
										</span>
									)}
								</div>

								{/* Stock warning */}
								<StockWarning
									item={item}
									variantId={item.productVariantId}
									onRemove$={handleStockRemove$}
								/>

								{/* Qty — hidden for OOS */}
								{!isOOS && (
									<div class="flex items-center mt-3">
										{isInEditableUrl && !isOrderConfirmation ? (
											<QuantityDropdown
												id={`quantity-${item.productVariantId}`}
												value={item.quantity}
												options={quantityOpts}
												theme={isCheckoutView ? 'dark' : 'light'}
												disabled={!isInEditableUrl}
												onChange$={handleQtyChange$}
											/>
										) : (
											<span class={`text-[12px] ${isCheckoutView ? 'text-[rgba(253,250,246,0.7)]' : 'text-[rgba(26,26,26,0.7)]'}`}>Qty {item.quantity}</span>
										)}
									</div>
								)}
							</div>

							{/* Price + Remove */}
							<div class="flex flex-col items-end justify-between min-w-[84px]">
								<span class={`text-right text-[14px] font-medium shrink-0 tabular-nums ${isCheckoutView ? 'text-[#FDFAF6]' : 'text-[#1A1A1A]'}`}>
									{formatPrice(linePrice, currencyCode)}
								</span>
								{isInEditableUrl && (
									<button
										data-variant-id={item.productVariantId}
										aria-label="Remove item"
										class={`p-1.5 -mr-1 transition-colors duration-150 cursor-pointer bg-transparent border-0 ${isCheckoutView ? 'text-[rgba(253,250,246,0.35)] hover:text-[rgba(253,250,246,0.7)]' : 'text-[rgba(26,26,26,0.28)] hover:text-[rgba(26,26,26,0.65)]'}`}
										onClick$={handleRemoveItem$}
									>
										<TrashIcon />
									</button>
								)}
							</div>
						</li>
					);
				})}

				{/* Render Vendure order lines when in Vendure mode OR when explicit order prop is passed */}
				{order && (order.lines || []).map((line) => {
					const { linePriceWithTax } = line;
					const productSlug = line.productVariant.product?.slug || '';
					const productName = line.productVariant.product?.name ||
						productNameCache.value[productSlug] ||
						productSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
					const vLabel = variantLabel(line.productVariant.name, productName);

					return (
						<li key={line.id} class="py-5 grid grid-cols-[88px_minmax(0,1fr)_auto] gap-4 w-full">
							{/* Image */}
							<div class={`shrink-0 w-[88px] h-[112px] overflow-hidden ${isCheckoutView ? 'bg-[rgba(253,250,246,0.06)]' : 'bg-[rgba(17,17,17,0.04)]'}`}>
								<OptimizedImage
									class="w-full h-full object-center object-cover"
									src={line.featuredAsset?.preview || '/asset_placeholder.webp'}
									width={160}
									height={200}
									loading="lazy"
									responsive="thumbnail"
									alt={`Image of: ${line.productVariant.name}`}
								/>
							</div>

							{/* Product Details */}
							<div class="flex flex-col justify-between min-w-0">
								<div class="min-w-0">
									<h3 class={`text-[15px] font-normal leading-snug truncate font-heading ${isCheckoutView ? 'text-[#FDFAF6]' : 'text-[#1A1A1A]'}`}>
										{line.productVariant.product?.slug ? (
											<Link
												href={`/products/${line.productVariant.product.slug}/`}
												data-slug={line.productVariant.product.slug}
								data-preview={line.featuredAsset?.preview || ''}
								onClick$={handleLinkClick$}
											>
												{productName}
											</Link>
										) : (
											<span>{productName}</span>
										)}
									</h3>
									{vLabel && (
										<p class={`text-[11px] mt-0.5 capitalize tracking-wide ${isCheckoutView ? 'text-[rgba(253,250,246,0.48)]' : 'text-[rgba(26,26,26,0.5)]'}`}>{vLabel}</p>
									)}
									{isOrderConfirmation && (line as any).productVariant?.customFields?.isPreOrder && (
										<div class="mt-1 mb-1">
											<span class="font-medium text-gray-700 text-sm">Qty: {line.quantity}</span>
										</div>
									)}
									{(line as any).productVariant?.customFields?.isPreOrder && (
										<span class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-[1.5px] uppercase font-heading mt-1 border border-[#965341]/30 text-[#965341] bg-[#965341]/5">
											Pre-order
											{(line as any).productVariant?.customFields?.shipDate && (
												<span class="text-[#8a6d4a]">· Ships {(line as any).productVariant.customFields.shipDate}</span>
											)}
										</span>
									)}
								</div>

								{/* Quantity */}
								{!(isOrderConfirmation && (line as any).productVariant?.customFields?.isPreOrder) && (
									<div class="flex items-center mt-3">
										{isInEditableUrl && !isOrderConfirmation ? (
											<QuantityDropdown
												id={`quantity-${line.id}`}
												value={line.quantity}
												options={quantityOptionsCache.value[line.id] || [1, 2, 3]}
												theme={isCheckoutView ? 'dark' : 'light'}
												disabled={!isInEditableUrl}
												onChange$={handleQtyChange$}
											/>
										) : (
											<span class={`text-[12px] ${isCheckoutView ? 'text-[rgba(253,250,246,0.7)]' : 'text-[rgba(26,26,26,0.7)]'}`}>Qty {line.quantity}</span>
										)}
									</div>
								)}
							</div>

							{/* Price + Remove */}
							<div class="flex flex-col items-end justify-between min-w-[84px]">
								<span class={`text-right text-[14px] font-medium shrink-0 tabular-nums ${isCheckoutView ? 'text-[#FDFAF6]' : 'text-[#1A1A1A]'}`}>
									<Price
										priceWithTax={linePriceWithTax}
										currencyCode={currencyCode}
									/>
								</span>
								{isInEditableUrl && (
									<button
										data-variant-id={line.productVariant.id}
										aria-label="Remove item"
										class={`p-1.5 -mr-1 transition-colors duration-150 cursor-pointer bg-transparent border-0 ${isCheckoutView ? 'text-[rgba(253,250,246,0.35)] hover:text-[rgba(253,250,246,0.7)]' : 'text-[rgba(26,26,26,0.28)] hover:text-[rgba(26,26,26,0.65)]'}`}
										onClick$={handleRemoveItem$}
									>
										<TrashIcon />
									</button>
								)}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
});
