// Brand views PR2: the "earn N points" line a brand product view may place. It wraps the L1 LoyaltyPdpEarn (program read and per-product
// multiplier stay in L1); the brand passes the product id and the price it shows, both from its view data.
import { component$ } from '@qwik.dev/core';
import { LoyaltyPdpEarn } from '~/components/loyalty/LoyaltyPdpEarn';

export const LoyaltyEarnWidget = component$<{ productId: string | null; priceCents: number }>((props) => (
	<LoyaltyPdpEarn cents={props.priceCents} productId={props.productId} />
));
