// An eject (or L3 file) that only restyles: allowed framework symbols, a type-only registry import, the public platform
// modules, presentation (L2) and asset imports.
import { component$, useSignal } from '@qwik.dev/core';
import type { QRL } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import type { SlotProps } from '~/components/slots/registry';
import { formatMoney, type Cents } from '~/platform/views';
import type { BrandHeadSpec } from '~/platform/head';
import Button from '~/components/ui/Button';
import { Pure } from '~/components/ui/Pure';
import '~/brand/brand.css';

export const price: Cents = 100;
export const spec: BrandHeadSpec = { titleTemplate: '%s' };
export type Props = SlotProps<'x.y'> & { onGo$?: QRL<() => void> };

export default component$<Props>((props) => {
	const open = useSignal(false);
	const el = document.createElement('div');
	return (
		<Button>
			<Link href="/cart/">{formatMoney(price)}{Pure(props.a)}{String(open.value)}</Link>
			<span ref={(e: Element) => el.append(e)} />
		</Button>
	);
});
