import { component$, useTask$ } from '@qwik.dev/core';
import { isBrowser } from '@qwik.dev/core/build';
import { useDocumentHead, useLocation } from '@qwik.dev/router';
import { DEFAULT_METADATA_TITLE } from '~/constants';
import { cssText, sanitizeInlineScript } from '~/utils/sanitize-lite';
import { useStoreIdentityLoader } from '~/routes/layout';
import { PROVIDER_PREFETCH_ORIGINS } from '~/platform/payments/labels';
import { brandHeadTags, DEFAULT_SOURCES, resolveHead } from '~/platform/head';
import { STALE_BUILD_RECOVERY_SOURCE } from '~/platform/stale-build-recovery';

interface HeadProps {
	nonce?: string;
	country?: string;
}

export const Head = component$<HeadProps>(({ nonce, country }) => {
	const documentHead = useDocumentHead();
	const loc = useLocation();
	// WS-C: runtime store identity/theme, resolved per-request by the root
	// layout's routeLoader$ (safe to call from any component for this route —
	// unlike a plain useContext, a loader doesn't require Head to be a
	// descendant of where the loader is invoked in the render tree).
	const identity = useStoreIdentityLoader().value.identity;
	// Brand views (plan §2.4): the route's head merged with src/brand/head.json and routes.json by one precedence rule. With none of
	// them this is the route head with the base defaults, as before.
	const resolved = resolveHead(documentHead, loc.url.pathname, identity);
	const head = resolved.head;
	const brandHead = DEFAULT_SOURCES.spec;

	// The initial <html lang> (entry.ssr.tsx containerAttributes) is the
	// build-time static theme's locale — the real per-request store identity
	// isn't resolved yet when that tag is opened. Once it is (here), reconcile
	// the live DOM attribute for any store whose runtime locale differs, so
	// assistive tech / the browser's own language handling matches the
	// actual resolved store for the rest of the session.
	useTask$(({ track }) => {
		const locale = track(() => identity.locale);
		if (!isBrowser || !locale) return;
		document.documentElement.lang = locale;
	});

	return (
		<head>
			<meta charSet="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
			<meta name="theme-color" content="#1a1a1a" />
			<meta name="theme-color" content="#2a2a2a" media="(prefers-color-scheme: light)" />
			<meta name="theme-color" content="#1a1a1a" media="(prefers-color-scheme: dark)" />
			<meta name="color-scheme" content="dark light" />
			<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

			{/* Critical CSS for above-the-fold content - improves FCP/LCP on mobile */}
			<style>{`
				html {
					background-color: #1a1a1a;
				}
				body {
					background-color: transparent;
					margin: 0;
					padding: 0;
					font-family: var(--font-body);
				}
				/* Critical hero styles for LCP optimization */
				.hero-section {
					position: relative;
					overflow: hidden;
					height: 70vh;
					min-height: 500px;
				}
				@media (min-width: 1024px) {
					.hero-section {
						height: 100vh;
					}
				}
				.hero-image {
					width: 100%;
					height: 100%;
					object-fit: cover;
					image-rendering: -webkit-optimize-contrast;
					image-rendering: crisp-edges;
				}
				/* Prevent layout shift */
				.btn-link {
					display: inline-block;
					text-align: center;
					font-weight: 700;
					text-transform: uppercase;
					transition: all 0.3s;
					color: var(--color-ink);
					background-color: var(--color-accent);
				}
			`}</style>

			{/* iPhone Advanced Privacy Protection compatibility */}
			<meta name="apple-mobile-web-app-capable" content="yes" />
			<meta name="apple-mobile-web-app-title" content={identity.storeName} />
			<meta name="format-detection" content="telephone=no" />
			<meta name="msapplication-tap-highlight" content="no" />


			{/* Privacy-friendly tracking prevention */}
			<meta name="referrer" content="strict-origin-when-cross-origin" />
			<meta httpEquiv="X-Frame-Options" content="SAMEORIGIN" />
			<meta httpEquiv="X-Content-Type-Options" content="nosniff" />

			{/* Disable problematic features that trigger privacy warnings */}
			<meta name="apple-touch-fullscreen" content="yes" />
			<meta name="mobile-web-app-capable" content="yes" />

			{/* Additional iOS privacy-friendly settings */}
			<meta name="apple-mobile-web-app-orientations" content="portrait" />
			<meta name="msapplication-TileColor" content="#000000" />
			<meta name="msapplication-config" content="none" />

			{/* Resource hints - Critical external domains */}

			{/* Payment processors - dns-prefetch only, used on checkout */}
			<link rel="dns-prefetch" href="https://secure.nmi.com" />

			{/* SheerID verification service - dns-prefetch only, loaded on-demand */}
			<link rel="dns-prefetch" href="https://services.sheerid.com" />
			{PROVIDER_PREFETCH_ORIGINS.map((href) => (
				<link key={href} rel="dns-prefetch" href={href} />
			))}


			{/* Geolocation services for address validation */}
			<link rel="dns-prefetch" href="https://ipapi.co" />
			<link rel="dns-prefetch" href="https://api.country.is" />
			<link rel="dns-prefetch" href="https://get.geojs.io" />



			{/* Service Worker for iOS privacy optimization (head.json serviceWorker: 'register-ios-privacy' is the default) */}
			{brandHead.serviceWorker !== 'none' && (
				<script
					{...(nonce ? { nonce } : {})}
					dangerouslySetInnerHTML={sanitizeInlineScript(brandHead.serviceWorker === 'unregister-ios-privacy' ? `
				if ('serviceWorker' in navigator) {
					navigator.serviceWorker.getRegistrations().then((registrations) => {
						registrations.forEach((r) => {
							if (r.active && r.active.scriptURL.indexOf('/ios-privacy-sw.js') > -1) r.unregister();
						});
					}).catch(() => {});
				}
			` : `
				if ('serviceWorker' in navigator && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
					window.addEventListener('load', () => {
						navigator.serviceWorker.register('/ios-privacy-sw.js')
							.catch(() => {
								// Silent fail - service workers are optional
							});
					});
				}
			`)}
				/>
			)}
			<title>{head.title || DEFAULT_METADATA_TITLE}</title>

			<link rel="manifest" href="/manifest.json" />
			{/* The base imports no web font (the CSP allows font-src 'self' only): a brand self-hosts its fonts and preloads
			    them through head.json fontPreloads. googleFontsPreconnect: true opts back into these hints. */}
			{resolved.googleFontsPreconnect && <link rel="preconnect" href="https://fonts.googleapis.com" />}
			{resolved.googleFontsPreconnect && <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />}



			{/* Favicon — SVG only (a brand favicon spec replaces it, never both) */}
			{resolved.favicon ? (
				<>
					{resolved.favicon.svg && <link rel="icon" href={resolved.favicon.svg} type="image/svg+xml" />}
					{resolved.favicon.ico && <link rel="icon" href={resolved.favicon.ico} sizes="any" />}
					{resolved.favicon.appleTouch && <link rel="apple-touch-icon" href={resolved.favicon.appleTouch} />}
				</>
			) : (
				<link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml" />
			)}

			{/* Canonical: use page-specific if provided, otherwise default */}
			{head.links.some((l: any) => l.rel === 'canonical')
				? null
				: <link rel="canonical" href={resolved.canonical ?? `${identity.siteOrigin}${loc.url.pathname}`} />
			}

			{head.meta
				.filter((m: any) => !m.name?.startsWith('json-ld-'))
				.map((m: any, key: number) => (
				<meta key={key} {...m} />
			))}

			{/* JSON-LD structured data — must be script tags, not meta tags */}
			{head.meta
				.filter((m: any) => m.name?.startsWith('json-ld-'))
				.map((m: any, key: number) => (
				<script key={`jsonld-${key}`} type="application/ld+json" dangerouslySetInnerHTML={m.content} />
			))}

			{head.links
				.filter((l: any) => {
					// Filter out invalid links that would cause browser warnings
					if (!l || !l.rel) return false;

					const rel = l.rel.toLowerCase();

					// modulepreload and preload MUST have href
					if ((rel === 'modulepreload' || rel === 'preload') && !l.href) {
						return false;
					}

					// preload MUST have 'as' attribute
					if (rel === 'preload' && !l.as) {
						return false;
					}

					return true;
				})
				.map((l: any, key: number) => (
					<link key={key} {...l} />
				))}

			{/* Reloads once if a deploy left this page with a missing chunk or an empty loader response (stale-build-recovery.ts). */}
			<script key="stale-build-recovery" {...(nonce ? { nonce } : {})} dangerouslySetInnerHTML={STALE_BUILD_RECOVERY_SOURCE} />
			{brandHeadTags(resolved, nonce, country)}

			{head.styles.map(({ key, style, ...props }) => (
				<style key={key} {...props} dangerouslySetInnerHTML={cssText(style ?? '')} />
			))}
		</head>
	);
});
