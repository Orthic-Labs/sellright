// Brand views, plan §2.3/§2.5: the content, home, blog and contact mounts, and the two form hooks the base pages and the brand views
// share. Everything that reads a loader, posts a form or loads a script lives here (L1); the brand view gets projections and actions.
import { $, component$, useComputed$, useSignal, useStore, useVisibleTask$, type ReadonlySignal } from '@qwik.dev/core';
import { isServer } from '@qwik.dev/core/build';
import { server$, useLocation } from '@qwik.dev/router';
import { useStoreIdentityLoader } from '~/routes/layout';
import { mountTurnstile, resetTurnstile, TURNSTILE_SITE_KEY } from '~/utils/turnstile-widget';
import { useFeaturedProducts } from '~/platform/home';
import { BLOG_PAGE_SIZE, useBlogPost, useBlogPosts, useRelatedPosts } from '~/platform/blog';
import { DECLARED_CONTENT } from '~/platform/brand-data';
import { matchDeclaredPath } from '~/platform/content-routes';
import { dispatch, type ActionCtl, type DispatchResults } from './callbacks';
import { FORM_RESULT } from '~/platform/gateway/actions';
import { submitContact, submitNewsletter, type FormPort, type FormStatus } from './forms';
import { buildBlogListView, buildBlogPostView } from './blog-view';
import { projectFeatured, projectFormState, projectIdentity, seal } from './project';
import { BlogListView, BlogPostView, ContactView, ContentView, HomeView, platformAction } from '~/platform/gateway';
import type { BlogListViewProps, BlogPostViewProps, ContactViewProps, ContentViewProps, FormResult, FormState, HomeSpotlight, HomeViewProps } from '~/platform/views';
import { useHomeSpotlight } from '~/platform/home-spotlight';
import { useConfigurator, type ConfiguratorLoaderValue } from './configurator';

const FORM_RESULTS: DispatchResults<FormResult> = {
	busy: { ok: false, reason: 'busy' },
	disposed: { ok: false, reason: 'disposed' },
	error: { ok: false, reason: 'server' },
	schema: FORM_RESULT,
};

// ---------------------------------------------------------------------------------------------------- newsletter (routes/index.tsx)

/** Moved from routes/index.tsx: the newsletter signup state, its Turnstile widget and its submit. */
export function useNewsletterForm() {
	const email = useSignal('');
	const honeypot = useSignal('');
	const state = useSignal<FormStatus>('idle');
	const error = useSignal('');
	const token = useSignal('');
	const ctl = useStore<ActionCtl>({ disposed: false, admitted: [] });

	useVisibleTask$(({ cleanup }) => {
		cleanup(() => { ctl.disposed = true; });
		mountTurnstile('nl-turnstile', (t) => { token.value = t; }, () => { token.value = ''; });
	});

	const submit = $((rawEmail: string, rawHoneypot: string): Promise<FormResult> => {
		const port: FormPort = {
			getStatus: () => state.value,
			setStatus: (s) => { state.value = s; },
			setMessage: (m) => { error.value = m; },
			getToken: () => token.value,
			clearToken: () => { token.value = ''; },
			resetWidget: resetTurnstile,
			turnstileRequired: !!TURNSTILE_SITE_KEY,
		};
		return submitNewsletter(
			port,
			{
				post: async (body) => {
					const res = await fetch('/newsletter-signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
					return { ok: res.ok, status: res.status };
				},
				onSuccess: () => { email.value = ''; },
			},
			rawEmail,
			rawHoneypot,
		);
	});

	/** The base form's submit: reads its own fields. */
	const handleSubmit = $(async () => { await submit(email.value, honeypot.value); });
	/** The brand action: validated, serialised, one request per submit. */
	const onSubscribe$ = $((rawEmail: string, rawHoneypot: string) => dispatch(ctl, 'submit', FORM_RESULTS, () => submit(String(rawEmail), String(rawHoneypot))));
	const form = useComputed$<FormState>(() => projectFormState({ status: state.value, message: error.value, turnstileRequired: !!TURNSTILE_SITE_KEY, turnstileReady: token.value !== '' }));
	return { email, honeypot, state, error, token, handleSubmit, onSubscribe$, form };
}

// ---------------------------------------------------------------------------------------------------- contact (routes/contact/index.tsx)

const submitFormServer = server$(async function (formData: {
	name: string; email: string; subject: string; message: string;
	turnstileToken: string; honeypot: string;
}) {
	const { submitContactForm } = await import('~/providers/shop/contact/contact');
	return submitContactForm(formData);
});

/** Moved from routes/contact/index.tsx: the contact form state, its Turnstile widget and its submit. */
export function useContactForm() {
	const name = useSignal('');
	const email = useSignal('');
	const subject = useSignal('GENERAL');
	const message = useSignal('');
	const honeypot = useSignal('');
	const turnstileToken = useSignal('');
	const formState = useSignal<FormStatus>('idle');
	const errorMessage = useSignal('');
	const ctl = useStore<ActionCtl>({ disposed: false, admitted: [] });

	useVisibleTask$(({ cleanup }) => {
		cleanup(() => { ctl.disposed = true; });
		if (!TURNSTILE_SITE_KEY) return;
		(window as any).onTurnstileLoad = () => {
			const container = document.getElementById('turnstile-container');
			if (!container) return;
			(window as any).turnstile.render(container, {
				sitekey: TURNSTILE_SITE_KEY,
				theme: 'light',
				// Hidden unless Cloudflare needs the shopper to interact.
				appearance: 'interaction-only',
				callback: (token: string) => { turnstileToken.value = token; },
				'expired-callback': () => { turnstileToken.value = ''; },
			});
		};
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
		script.async = true;
		document.head.appendChild(script);
	});

	// Ready = the same required fields the submit checks.
	const contactReady = name.value.trim().length > 0 && email.value.trim().length > 0 && message.value.trim().length > 0;

	const submit = $((fields: { name: string; email: string; subject: string; message: string; honeypot: string }): Promise<FormResult> => {
		const port: FormPort = {
			getStatus: () => formState.value,
			setStatus: (s) => { formState.value = s; },
			setMessage: (m) => { errorMessage.value = m; },
			getToken: () => turnstileToken.value,
			clearToken: () => { turnstileToken.value = ''; },
			resetWidget: resetTurnstile,
			turnstileRequired: !!TURNSTILE_SITE_KEY,
		};
		return submitContact(port, { send: (payload) => submitFormServer(payload) }, fields);
	});

	const handleSubmit = $(async () => {
		await submit({ name: name.value, email: email.value, subject: subject.value, message: message.value, honeypot: honeypot.value });
	});
	const onSubmit$ = $((n: string, e: string, s: string, m: string, h: string) =>
		dispatch(ctl, 'submit', FORM_RESULTS, () => submit({ name: String(n), email: String(e), subject: String(s), message: String(m), honeypot: String(h) })),
	);
	const form = useComputed$<FormState>(() => projectFormState({ status: formState.value, message: errorMessage.value, turnstileRequired: !!TURNSTILE_SITE_KEY, turnstileReady: turnstileToken.value !== '' }));
	return { name, email, subject, message, honeypot, turnstileToken, formState, errorMessage, contactReady, handleSubmit, onSubmit$, form };
}

// ---------------------------------------------------------------------------------------------------- mounts

/** Built-in static pages and the key `route.content` receives for them. */
const BUILT_IN_PAGE_KEYS: Record<string, string> = { '/about/': 'about', '/privacy/': 'privacy', '/terms/': 'terms', '/returns/': 'returns', '/press/': 'press' };

/** The `pageKey` for a request path: a built-in page, or a path declared in routes.json. */
export const pageKeyFor = (pathname: string): string | null => {
	const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
	return BUILT_IN_PAGE_KEYS[path] ?? matchDeclaredPath(DECLARED_CONTENT, path)?.pageKey ?? null;
};

/** `route.content`: the built-in static pages and the declared content paths. */
export const BrandContentMount = component$<Pick<ContentViewProps, 'reviewSummary'>>((props) => {
	const location = useLocation();
	const identity = useStoreIdentityLoader();
	const data = useComputed$(() => {
		const summary = props.reviewSummary;
		return seal<ContentViewProps>({
			identity: projectIdentity(identity.value.identity) as ContentViewProps['identity'],
			pageKey: pageKeyFor(location.url.pathname) ?? '',
			pathname: location.url.pathname,
			...(summary === undefined ? {} : { reviewSummary: summary === null ? null : {
				score: summary.score,
				count: summary.count,
				reviews: summary.reviews.map((review) => ({ text: review.text, name: review.name })),
			} }),
		});
	});
	return <ContentView {...data.value} />;
});

/** `route.home`. */
export const BrandHomeMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const featured = useFeaturedProducts();
	const form = useNewsletterForm();
	// routes.json home.spotlight: the shared configurator over one product (its own live stock read, qidle). With no spotlight the
	// configurator has no products: it reads nothing and every action is `invalid`.
	const spotlight = useHomeSpotlight();
	const c = useConfigurator(spotlight as ReadonlySignal<ConfiguratorLoaderValue>, 'spotlight');
	const data = useComputed$(() =>
		seal<Pick<HomeViewProps, 'identity' | 'featured'>>({
			identity: projectIdentity(identity.value.identity) as HomeViewProps['identity'],
			featured: projectFeatured(featured.value) as HomeViewProps['featured'],
		}),
	);
	// Projected in the render body (a computed reading the configurator's projection loses its captures in production builds).
	const v = c.project();
	const product = spotlight.value ? (v.products[0] ?? null) : null;
	const spot = product ? (seal<HomeSpotlight>({ product, selection: v.selection, purchase: v.purchase } as HomeSpotlight) as HomeSpotlight) : null;
	return (
		<HomeView
			{...data.value}
			spotlight={spot}
			newsletter={form.form.value}
			onSubscribe$={platformAction('home.subscribe', form.onSubscribe$)}
			onOptionSelect$={platformAction('configurator.option-select', c.onOptionSelect$)}
			onQuantityChange$={platformAction('configurator.quantity', c.onQuantityChange$)}
			onConsentChange$={platformAction('configurator.consent', c.onConsentChange$)}
			onAddToCart$={platformAction('configurator.add', c.onAddToCart$)}
			onRetryStock$={platformAction('configurator.retry-stock', c.onRetryStock$)}
		/>
	);
});

/** `route.blog`. A list longer than the page has no crawlable link past it, so the mount warns on the server. */
export const BrandBlogMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const list = useBlogPosts();
	const data = useComputed$(() => buildBlogListView(projectIdentity(identity.value.identity) as BlogListViewProps['identity'], list.value.items, list.value.totalItems, BLOG_PAGE_SIZE));
	if (isServer && data.value.hasMore) console.warn(`blog list: ${data.value.total} posts but only ${data.value.posts.length} are listed; posts past the page have no crawlable link (raise blog.pageSize, max 100)`);
	return <BlogListView {...data.value} />;
});

/** `route.blog-post`: `found` or `missing` (the loader already set the 404 status for a missing post). */
export const BrandBlogPostMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const postLoader = useBlogPost();
	const relatedLoader = useRelatedPosts();
	const data = useComputed$(() => buildBlogPostView(projectIdentity(identity.value.identity) as BlogPostViewProps['identity'], postLoader.value, relatedLoader.value));
	return <BlogPostView {...data.value} />;
});

/** `route.contact`. */
export const BrandContactMount = component$(() => {
	const identity = useStoreIdentityLoader();
	const form = useContactForm();
	const data = useComputed$(() => seal<Omit<ContactViewProps, 'form' | 'onSubmit$'>>({ identity: projectIdentity(identity.value.identity) as ContactViewProps['identity'] }));
	return <ContactView {...data.value} form={form.form.value} onSubmit$={platformAction('contact.submit', form.onSubmit$)} />;
});
