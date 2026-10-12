// Fixture view: static content pages and declared content paths.
import { component$ } from '@qwik.dev/core';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.content'>>((props) => (
	<main data-testid="view-content" data-page-key={props.pageKey} data-pathname={props.pathname}>{`content:${props.pageKey}:${props.identity.storeName}`}</main>
));
