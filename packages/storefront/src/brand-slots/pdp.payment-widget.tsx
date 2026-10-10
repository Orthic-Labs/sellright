// Base default for the `pdp.payment-widget` slot: the installment-payment line that used to be inlined in
// ProductPageView.tsx. The rules below were cut out of product-styles.ts unchanged; the `.sr-sezzle-inline` class is
// used by nothing else, so moving them cannot change any other element's cascade.
import { component$, useStyles$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

const SEZZLE_ENABLED = !!(import.meta.env.VITE_SEZZLE_MERCHANT_UUID as string | undefined);

export default component$<SlotProps<'pdp.payment-widget'>>(({ priceCents }) => {
	useStyles$(`.sr-sezzle-inline{font-size:13px;color:var(--light);margin-bottom:6px;line-height:1.6;}.sr-sezzle-inline strong{color:var(--mid);font-weight:500;}.sr-sezzle-inline a{text-decoration:none;}.sr-sezzle-inline a:hover{opacity:0.7;}`);
	if (!SEZZLE_ENABLED) return null;
	return (
		<div class="sr-sezzle-inline">
			or 4 interest-free payments of <strong>${(priceCents / 400).toFixed(0)}</strong> with{' '}
			<a href="https://sezzle.com/how-it-works" target="_blank" rel="noopener noreferrer">
				<img src="/sezzle-color.svg" alt="Sezzle" width="58" height="16" loading="lazy" style={{ display: 'inline', verticalAlign: 'middle', marginLeft: '3px' }} />
			</a>
		</div>
	);
});
