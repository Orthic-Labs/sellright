import { component$, $ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { OptimizedImage } from '~/components/ui';
import { preloadImage } from '~/utils/image-cache';
import Price from './Price';

export default component$(
	({ productAsset, productName, slug, priceWithTax, inStock, priority = false, productId: _productId, salePrice, preOrderPrice, isPreOrder, skeleton = false }: any) => {
		const isLoading = skeleton || !productName;

		const handleCardClick = $(() => {
			if (productAsset?.preview) {
				const targetImageUrl = productAsset.preview + '?preset=xl';
				preloadImage(targetImageUrl);
			}
		});

		// Same DOM structure in both states — only inner content is conditional
		const outer = (
			<div class="overflow-hidden bg-[#F7F2EA] border-b border-r border-[#e4e2dc] transition-[background-color,box-shadow,border-color] duration-300 group-hover:bg-[#f0ebe2] group-hover:shadow-[0_8px_24px_rgba(0,0,0,0.08)] group-hover:border-[#965341]/20 flex flex-col">

				{/* Image area — always 3:4 */}
				<div class="relative overflow-hidden bg-[#1a1a18] flex-shrink-0 aspect-[3/4] ring-1 ring-inset ring-black/5">
					{isLoading ? (
						<div class="w-full h-full animate-pulse" />
					) : (
						<>
							{inStock === false && (
								<div class="absolute top-0 left-0 z-10 bg-[#111110] text-white px-3 py-1.5 text-[13px] font-normal uppercase tracking-[2px] font-heading">
									Sold Out
								</div>
							)}
							{!isPreOrder && salePrice != null && inStock !== false && (
								<div class="absolute top-0 left-0 z-10 bg-[#965341] text-[#0F0F0F] px-3 py-1.5 text-[13px] font-normal uppercase tracking-[2px] font-heading">
									Sale
								</div>
							)}
							{isPreOrder && inStock !== false && (
								<div class="absolute top-0 left-0 z-10 bg-[#111110] text-[#965341] px-3 py-1.5 text-[13px] font-normal uppercase tracking-[2px] font-heading">
									Pre-order
								</div>
							)}
							<OptimizedImage
								src={productAsset?.preview || '/asset_placeholder.webp'}
								class={`w-full h-full object-cover object-center transition-transform duration-500 ease-out group-hover:scale-[1.03] ${
									inStock === false ? 'opacity-50' : ''
								}`}
								width={400}
								height={500}
								loading={priority ? 'eager' : 'lazy'}
								priority={priority}
								responsive="productCard"
								alt={`${productName} — Damned Designs`}
							/>
						</>
					)}
				</div>

				{/* Info area — same height/padding in both states */}
				<div class="border-t border-[#e4e2dc] flex flex-col gap-1 px-4 py-4">
					{isLoading ? (
						<>
							<div class="h-[17px] bg-[#e4e2dc] rounded w-3/4 animate-pulse" />
							<div class="h-[19px] bg-[#e4e2dc] rounded w-1/3 mt-1.5 animate-pulse" />
						</>
					) : (
						<>
							<h3
								class={`font-heading font-normal text-[20px] leading-tight tracking-tight ${
									inStock === false ? 'text-[#50504d]' : 'text-[#111110]'
								}`}
							>
								{productName}
							</h3>

							<div class="flex items-baseline gap-2 mt-1.5">
								<Price
									priceWithTax={priceWithTax}
									forcedClass={`font-heading font-normal text-[19px] text-[#111110] ${inStock === false ? 'text-[#adadaa]' : ''}`}
									salePrice={salePrice}
									preOrderPrice={preOrderPrice}
									isPreOrder={isPreOrder}
									originalPriceClass="font-heading text-[#adadaa]"
									currencyCode="USD"
								/>
							</div>

							<div class="opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-[opacity,transform] duration-200 ease-out mt-1 pt-1">
								<div class="flex items-center gap-2">
									<div class="w-5 h-px bg-[#965341] flex-shrink-0"></div>
									<span class="text-[13px] tracking-[2.5px] uppercase text-[#965341] font-normal font-heading">
										{isPreOrder ? 'Pre-order now' : inStock === false ? 'Notify me' : 'View product'}
									</span>
								</div>
							</div>
						</>
					)}
				</div>
			</div>
		);

		if (isLoading) {
			return <div class="group block">{outer}</div>;
		}

		return (
			<Link
				href={`/products/${slug}/`}
				prefetch
				class="group block active:scale-[0.97] transition-transform duration-150"
				onClick$={handleCardClick}
			>
				{outer}
			</Link>
		);
	}
);
