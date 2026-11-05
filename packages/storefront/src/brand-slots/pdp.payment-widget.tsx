// Base default for the `pdp.payment-widget` slot: the installment-payment line that used to be inlined in
// ProductPageView.tsx. The rules below were cut out of product-styles.ts unchanged; the `.sr-sezzle-inline` class is
// used by nothing else, so moving them cannot change any other element's cascade.
import { component$, useStyles$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

// Each of the four payments, to the cent (Sezzle splits the total into four; the first absorbs any odd cent). "$4" for a
// $15 item read as $16 in total (#402).
const sezzleInstallment = (priceCents: number): string => {
	const cents = Math.ceil(priceCents / 4);
	return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
};

const SEZZLE_ENABLED = !!(import.meta.env.VITE_SEZZLE_MERCHANT_UUID as string | undefined);

export default component$<SlotProps<'pdp.payment-widget'>>(({ priceCents }) => {
	useStyles$(`.sr-sezzle-inline{font-size:13px;color:var(--light);margin-bottom:6px;line-height:1.6;}.sr-sezzle-inline strong{color:var(--mid);font-weight:500;}.sr-sezzle-inline a{text-decoration:none;}.sr-sezzle-inline a:hover{opacity:0.7;}`);
	if (!SEZZLE_ENABLED) return null;
	return (
		<div class="sr-sezzle-inline">
			or 4 interest-free payments of <strong>${sezzleInstallment(priceCents)}</strong> with{' '}
			<a href="https://sezzle.com/how-it-works" target="_blank" rel="noopener noreferrer">
				<img src="/sezzle-color.svg" alt="Sezzle" width="58" height="16" loading="lazy" style={{ display: 'inline', verticalAlign: 'middle', marginLeft: '3px' }} />
			</a>
		</div>
	);
});
