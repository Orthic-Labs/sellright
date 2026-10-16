// Fixture view: the shell header. Data props render; the actions go through the platform's dispatcher.
import { component$, useSignal } from '@qwik.dev/core';
import { Link } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'shell.header'>>((props) => {
	const last = useSignal('');
	return (
		<header data-testid="view-header" data-path={props.pathname} data-home={String(props.isHome)} data-signed-in={String(props.account.signedIn)}>
			<Link href="/" data-testid="view-header-home">{props.identity.storeName}</Link>
			<button type="button" data-testid="view-header-cart" onClick$={async () => { const r = await props.onCartToggle$(); last.value = r.ok ? 'ok' : r.reason; }}>
				{`cart:${props.cartQuantity}:${props.cartOpen ? 'open' : 'closed'}`}
			</button>
			<button type="button" data-testid="view-header-login" onClick$={() => props.onLogin$()}>login</button>
			<span data-testid="view-header-last">{last.value}</span>
		</header>
	);
});
