import { component$, useStyles$ } from '@qwik.dev/core';

const SKELETON_STYLES = `
	@keyframes skeleton-shimmer {
		0% { background-position: -468px 0; }
		100% { background-position: 468px 0; }
	}
` as const;

export default component$(() => {
	useStyles$(SKELETON_STYLES);
	return (
		<div class="overflow-hidden bg-[var(--color-parchment)] border-b border-r border-[var(--color-card-border)]">
			{/* Image Skeleton */}
			<div class="relative aspect-3/4 w-full overflow-hidden bg-[#ebe5db]">
				<div class="absolute inset-0" style="background:linear-gradient(90deg,#ebe5db 25%,#e3dbd0 37%,#ebe5db 63%);background-size:936px 100%;animation:skeleton-shimmer 1.6s ease-in-out infinite"></div>
			</div>

			{/* Content Skeleton */}
			<div class="border-t border-[var(--color-card-border)] px-4 py-4 space-y-3">
				{/* Title Skeleton */}
				<div class="h-[17px] rounded w-3/4" style="background:linear-gradient(90deg,var(--color-card-border) 25%,#dbd5cb 37%,var(--color-card-border) 63%);background-size:936px 100%;animation:skeleton-shimmer 1.6s ease-in-out infinite"></div>

				{/* Price Skeleton */}
				<div class="h-[19px] w-20 rounded" style="background:linear-gradient(90deg,var(--color-card-border) 25%,#dbd5cb 37%,var(--color-card-border) 63%);background-size:936px 100%;animation:skeleton-shimmer 1.6s ease-in-out infinite"></div>
			</div>
		</div>
	);
});
