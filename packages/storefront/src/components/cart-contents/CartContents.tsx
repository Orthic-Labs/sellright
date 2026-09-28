import { component$, useContext, useSignal, useTask$, $ } from '@qwik.dev/core';
import { Link, useLocation } from '@qwik.dev/router';
import { OptimizedImage, QuantityDropdown } from '~/components/ui';
import { APP_STATE } from '~/constants';
import { getProductDetail } from '~/providers/shop/products/products';
import { formatPrice } from '~/utils';
import { isCheckoutPage } from '~/utils/route-helpers';
import { isImageCached } from '~/utils/image-cache';
import Price from '../products/Price';
import TrashIcon from '../icons/TrashIcon';
import { useCart, updateCartLineQuantity, removeCartLine } from '~/contexts/CartContext';
import { isLineAvailable, remainingQuantity } from '~/sellright/types/cart';
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

export default component$(() => {

	const location = useLocation();
	const appState = useContext(APP_STATE);
	const cartState = useCart();
	const currentOrderLineSignal = useSignal<{ id: string; value: number }>();
	const isCheckoutView = isCheckoutPage(location.url.toString());
	const isInEditableUrl = !isCheckoutView;
	const currencyCode = cartState.cart.currency || 'USD';

	const productNameCache = useSignal<Record<string, string>>({});
	const expandedDropdowns = useSignal<Set<string>>(new Set());

	// Component-level handlers — avoid .map() params crossing $() boundary
	const handleRemoveItem$ = $((e: Event) => {
		const btn = (e.target as HTMLElement).closest('[data-sku], [data-variant-id]') as HTMLElement;
		if (!btn) return;
		const sku = btn.dataset.sku ?? btn.dataset.variantId!;
		removeCartLine(cartState, sku).then(() => {
			if (cartState.cart.lines.length === 0) {
				appState.showCart = false;
			}
		}).catch(() => {});
	});

	const handleLinkClick$ = $((e: Event) => {
		const el = (e.target as HTMLElement).closest('[data-slug]') as HTMLElement;
		if (!el) return;
		handleProductLinkClick(el.dataset.slug!, el.dataset.preview || undefined);
	});

	const handleStockRemove$ = $((sku: string) => {
		removeCartLine(cartState, sku);
	});

	const handleQtyChange$ = $((value: number | string, id: string) => {
		const key = id.replace('quantity-', '');
		if (value === '10+') {
			expandedDropdowns.value = new Set([...expandedDropdowns.value, key]);
		} else {
			currentOrderLineSignal.value = { id: key, value: +value };
		}
	});

	useTask$(({ track, cleanup }) => {
		track(() => currentOrderLineSignal.value);
		let id: NodeJS.Timeout;
		if (currentOrderLineSignal.value) {
			id = setTimeout(async () => {
				try {
					await updateCartLineQuantity(
						cartState,
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

	// Fill in a product name for any native cart line whose enrichment lacks
	// one (an older/foreign cart mirror, or a line added before the catalog
	// resolved a name) — keyed by slug so it's fetched at most once per name.
	useTask$(async ({ track }) => {
		const lines = track(() => cartState.cart.lines);

		for (const line of lines) {
			if (!line.slug || line.name) continue;
			if (productNameCache.value[line.slug]) continue;
			try {
				const product = await getProductDetail(line.slug);
				if (product?.name) {
					productNameCache.value = {
						...productNameCache.value,
						[line.slug]: product.name
					};
				}
			} catch (error) {
				console.error('Error fetching product details for slug:', line.slug, error);
			}
		}
	});

	// Helper: strip product name prefix from variant name
	const variantLabel = (variantName: string, productName: string) => {
		const stripped = variantName.replace(productName, '').trim();
		return stripped.startsWith('-') ? stripped.substring(1).trim() : stripped;
	};

	// Helper: derive quantity options for cart lines. `remaining === null` is
	// the fail-closed-safe "uncapped" case — bounded to a sane dropdown size,
	// never treated as literally infinite.
	const qtyOptions = (remaining: number | null, currentQty: number, sku: string) => {
		const maxQty = remaining === null ? Math.max(currentQty, 99) : Math.max(remaining, currentQty);
		const expanded = expandedDropdowns.value.has(sku);
		if (maxQty <= 10) return Array.from({ length: maxQty }, (_, i) => i + 1);
		return expanded
			? Array.from({ length: maxQty }, (_, i) => i + 1)
			: [...Array.from({ length: 9 }, (_, i) => i + 1), '10+'];
	};

	return (
		<div class="flow-root w-full">
			<ul class={`divide-y w-full ${isCheckoutView ? 'divide-[rgba(var(--color-accent-rgb),0.25)]' : 'divide-[rgba(17,17,17,0.08)]'}`}>
				{/* Render native cart lines (the server-owned cart) */}
				{cartState.cart.lines.map((line) => {
					const productSlug = line.slug || '';
					const productName = line.name ||
						productNameCache.value[productSlug] ||
						productSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

					const linePrice = line.lineSubtotal;
					const isOOS = !isLineAvailable(line);
					const remaining = remainingQuantity(line);
					const quantityOpts = qtyOptions(remaining, line.quantity, line.sku);
					const vLabel = line.options ?? variantLabel(line.name, productName);

					return (
						<li key={line.sku} class="py-5 grid grid-cols-[88px_minmax(0,1fr)_auto] gap-4 w-full">
							{/* Image — square crop, no border radius for editorial feel */}
							<div class={`shrink-0 w-[88px] h-[112px] overflow-hidden ${isCheckoutView ? 'bg-[rgba(253,250,246,0.06)]' : 'bg-[rgba(17,17,17,0.04)]'}`}>
								<OptimizedImage
									class="w-full h-full object-center object-cover"
									src={line.image || '/asset_placeholder.webp'}
									width={160}
									height={200}
									loading="lazy"
									responsive="thumbnail"
									alt={`Image of: ${line.name}`}
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
								data-preview={line.image || ''}
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
									{line.isPreOrder && (
										<span class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-[1.5px] uppercase font-heading mt-1 border border-[var(--color-accent)]/30 text-[var(--color-accent)] bg-[var(--color-accent)]/5">
											Pre-order
											{line.shipDate && (
												<span class="text-[#8a6d4a]">· Ships {line.shipDate}</span>
											)}
										</span>
									)}
								</div>

								{/* Stock warning */}
								<StockWarning
									line={line}
									sku={line.sku}
									onRemove$={handleStockRemove$}
								/>

								{/* Qty — hidden for OOS */}
								{!isOOS && (
									<div class="flex items-center mt-3">
										{isInEditableUrl ? (
											<QuantityDropdown
												id={`quantity-${line.sku}`}
												value={line.quantity}
												options={quantityOpts}
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
									{formatPrice(linePrice, currencyCode)}
								</span>
								{isInEditableUrl && (
									<button
										data-sku={line.sku}
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
