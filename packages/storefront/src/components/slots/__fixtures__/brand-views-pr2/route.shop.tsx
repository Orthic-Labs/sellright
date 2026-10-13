// Fixture view: the shop configurator over routes.json shop.detailProducts. Renders state as data attributes for the e2e spec.
import { component$, useSignal } from '@qwik.dev/core';
import { Link } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.shop'>>((props) => {
	const outcome = useSignal('');
	return (
		<main data-testid="view-shop" data-stock={props.purchase.stock} data-reason={props.purchase.reason ?? ''} data-eligible={String(props.purchase.eligible)} data-detail-status={props.detailStatus} data-selected={props.selection.productKey ?? ''}>
			{props.detail.map((p) => (
				<button key={p.key} type="button" data-testid={`view-shop-product-${p.key}`} data-key={p.key} data-availability={p.availability} onClick$={(_, el) => props.onProductSelect$(el.dataset.key ?? '')}>
					{p.name}
				</button>
			))}
			<Link href="/shop/?style=oos" data-testid="view-shop-query-oos">oos</Link>
			<ul data-testid="view-shop-listing">
				{props.listing.map((item) => (
					<li key={item.slug} data-availability={item.availability}><a href={item.href}>{item.name}</a></li>
				))}
			</ul>
			<button type="button" data-testid="view-shop-add" onClick$={async () => {
				const r = await props.onAddToCart$();
				outcome.value = r.status === 'rejected' ? `rejected:${r.reason}` : r.status;
			}}>add</button>
			<span data-testid="view-shop-outcome">{outcome.value}</span>
		</main>
	);
});
