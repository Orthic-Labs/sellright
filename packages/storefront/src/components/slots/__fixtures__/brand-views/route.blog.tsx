// Fixture view: the blog list.
import { component$ } from '@qwik.dev/core';
import { Link } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.blog'>>((props) => (
	<main data-testid="view-blog" data-total={String(props.total)} data-page-size={String(props.pageSize)} data-has-more={String(props.hasMore)}>
		{props.posts.map((p) => (
			<article key={p.slug} data-slug={p.slug}><Link href={p.href}>{p.title}</Link> {`${p.readingTime} min`} {p.publishedAt ?? ''}</article>
		))}
	</main>
));
