// Brand views PR2: the product reviews block a brand product view may place. It wraps the L1 ProductReviews (its loads, form and
// submit stay in L1); the brand passes only the product's slug and display name, which the view already received as data.
import { component$ } from '@qwik.dev/core';
import { ProductReviews } from '~/components/reviews/ProductReviews';

export const ProductReviewsWidget = component$<{ slug: string; productName: string }>((props) => (
	<ProductReviews slug={props.slug} productName={props.productName} />
));
