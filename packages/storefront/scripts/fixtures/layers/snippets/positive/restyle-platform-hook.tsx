// An eject (or L3 file) that only restyles and reads a platform hook: framework, type-only, platform API,
// presentation (L2) and asset imports are all allowed.
import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import type { Money } from '~/types';
import { usePlatformCart } from '~/platform/hooks';
import Button from '~/components/ui/Button';
import '~/brand/brand.css';

export const price: Money = { amount: 1 };

export default component$(() => {
	const cart = usePlatformCart();
	return (
		<Button>
			<Link href="/cart/">{cart.count}</Link>
		</Button>
	);
});
