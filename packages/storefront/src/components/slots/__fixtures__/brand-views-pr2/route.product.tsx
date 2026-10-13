// Fixture view: a product page (found or missing).
import { component$, useSignal } from '@qwik.dev/core';
import { Link, ProductReviewsWidget } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.product'>>((props) => {
	const outcome = useSignal('');
	if (props.state === 'missing') return <main data-testid="view-product-missing"><a href={props.shopHref}>Back to the shop</a></main>;
	const p = props.product;
	return (
		<main data-testid="view-product" data-stock={props.purchase.stock} data-reason={props.purchase.reason ?? ''} data-eligible={String(props.purchase.eligible)} data-availability={p.availability}>
			<h1>{p.name}</h1>
			<span data-testid="view-product-siblings">{props.siblings.map((s) => s.key).join(',')}</span>
			{props.siblings.map((s) => (
				<Link key={s.key} href={s.href} data-testid={`view-product-sibling-${s.key}`}>{s.name}</Link>
			))}
			<span data-testid="view-product-crumb">{props.breadcrumbs.map((b) => b.name).join('/')}</span>
			<button type="button" data-testid="view-product-add" disabled={!props.purchase.eligible} onClick$={async () => {
				const r = await props.onAddToCart$();
				outcome.value = r.status === 'rejected' ? `rejected:${r.reason}` : r.status;
			}}>add</button>
			<button type="button" data-testid="view-product-forge" onClick$={async () => {
				const r = await props.onOptionSelect$('no-such-group', 'x');
				outcome.value = r.ok ? 'ok' : `forged:${r.reason}`;
			}}>forge</button>
			<span data-testid="view-product-outcome">{outcome.value}</span>
			<ProductReviewsWidget slug={p.slug} productName={p.name} />
		</main>
	);
});
