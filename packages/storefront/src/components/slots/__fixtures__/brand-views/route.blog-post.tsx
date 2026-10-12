// Fixture view: one blog post (or its missing state). The body is rendered only through RichContent.
import { component$ } from '@qwik.dev/core';
import { Link, RichContent } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

export default component$<SlotProps<'route.blog-post'>>((props) => {
	if (props.state === 'missing') return <main data-testid="view-post-missing">missing</main>;
	return (
		<main data-testid="view-post" data-slug={props.post.slug}>
			<h1>{props.post.title}</h1>
			<nav data-testid="view-post-toc">
				{props.post.toc.map((t) => (<a key={t.id} href={`#${t.id}`}>{t.text}</a>))}
			</nav>
			<RichContent content={props.post.body} class="view-post-body" />
			<ul data-testid="view-post-related">
				{props.related.map((r) => (<li key={r.slug}><Link href={r.href}>{r.title}</Link></li>))}
			</ul>
		</main>
	);
});
