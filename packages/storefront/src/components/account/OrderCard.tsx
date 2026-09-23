import { component$, $ } from '@qwik.dev/core';
import { useNavigate } from '@qwik.dev/router';
import { OptimizedImage } from '~/components/ui';
import { HighlightedButton } from '~/components/buttons/HighlightedButton';
import { Order } from '~/generated/graphql-shop';
import { formatPrice } from '~/utils';
import { isImageCached } from '~/utils/image-cache';

type IProps = {
	order: Order;
};

export default component$<IProps>(({ order }) => {
	const navigate = useNavigate();

	// Image preloading function for order detail navigation
	const handleOrderDetailClick = $(() => {
		// Preload images for the order detail page - focus on the first few order line images
		order.lines.slice(0, 3).forEach(line => {
			if (line.featuredAsset?.preview) {
				const targetImageUrl = line.featuredAsset.preview.replace('?preset=', '?preset=large');
				
				isImageCached(targetImageUrl).then((cached) => {
					if (!cached) {
						const img = new Image();
						img.src = targetImageUrl;
					}
				});
			}
		});
		
		navigate(`/account/orders/${order?.code}`);
	});

	return (
		<div class="container mx-auto p-9 bg-white max-w-sm rounded-2xl overflow-hidden shadow-xl hover:shadow-2xl transition duration-300 text-center">
			<OptimizedImage
				width={200}
				height={200}
				class="w-full h-full object-center object-cover m-auto"
				src={order.lines[0]?.featuredAsset?.preview || '/asset_placeholder.webp'}
				alt={order.lines[0]?.productVariant?.name || 'Order product image'}
				loading="lazy"
			/>
			<div class="items-center">
				<div>
					<h1 class="mt-5 text-sm">
						Order:
						<span class="ml-2 text-xl font-semibold">{order?.code}</span>
					</h1>
					<span class="bg-teal-200 text-teal-800 text-xs px-2 py-2 mt-2 inline-block rounded-full uppercase font-semibold tracking-wide">
						{({
							PaymentSettled:             'Processing',
							PaymentAuthorized:          'Authorized',
							PartiallyShipped:           'Partially Shipped',
							Shipped:                    'Shipped',
							PartiallyDelivered:         'Partially Delivered',
							Delivered:                  'Delivered',
							Cancelled:                  'Cancelled',
							Refunded:                   'Refunded',
							ArrangingAdditionalPayment: 'More Payment Due',
						} as Record<string, string>)[order.state] ?? order.state}
					</span>
					<p class="my-2">{formatPrice(order?.totalWithTax)}</p>
				</div>
			</div>			<div>
				<HighlightedButton
					extraClass="m-auto"
					onClick$={handleOrderDetailClick}
				>
					Go to detail
				</HighlightedButton>
			</div>
		</div>
	);
});
