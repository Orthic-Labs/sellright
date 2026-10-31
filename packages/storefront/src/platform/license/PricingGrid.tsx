import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import type { PricedProduct } from './catalog';
import { PRICE_PLACEHOLDER } from '~/platform/live-values';
import { fmtMoney } from './variant';

/** The license cards of the pricing and home pages. `pricePending` (ADR-0001 shell): prices hold their space until the live read lands. */
export const PricingGrid = component$<{ catalog: readonly PricedProduct[]; pricePending?: boolean }>(({ catalog, pricePending }) => (
	<div class="grid">
		{catalog.map((p) => (
			<div class="card" key={p.slug}>
				<h2>{p.name}</h2>
				{p.description && <p class="muted" style="font-size:13px;margin-top:6px">{p.description}</p>}
				{p.variants.map((v) => {
					const std = v.compareAtPrice;
					return (
						<div key={v.sku} style="margin-top:16px">
							<div class="price" aria-busy={pricePending ? 'true' : undefined}>
								{pricePending ? PRICE_PLACEHOLDER : fmtMoney(v.price)}
								{!pricePending && std && std > v.price && <small style="text-decoration:line-through;margin-left:8px">{fmtMoney(std)}</small>}
								{p.variants.length > 1 && <small> · {v.name}</small>}
							</div>
							<Link class="btn block" href={`/checkout/?sku=${encodeURIComponent(v.sku)}`}>
								Buy {p.variants.length > 1 ? v.name : 'license'}
							</Link>
						</div>
					);
				})}
			</div>
		))}
	</div>
));
