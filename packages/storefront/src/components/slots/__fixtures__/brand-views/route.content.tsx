// Fixture view: static content pages and declared content paths (and two client-navigation links for the single-segment spec).
import { component$ } from '@qwik.dev/core';
import { Link } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.content'>>((props) => (
	<main data-testid="view-content" data-page-key={props.pageKey} data-pathname={props.pathname}>
		{`content:${props.pageKey}:${props.identity.storeName}`}
		<Link href="/single-story/" data-testid="view-content-link-declared">declared</Link>
		<Link href="/no-such-single/" data-testid="view-content-link-undeclared">undeclared</Link>
	</main>
));
