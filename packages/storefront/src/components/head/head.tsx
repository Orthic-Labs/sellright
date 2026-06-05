import { component$ } from '@qwik.dev/core';
import { useDocumentHead, useLocation } from '@qwik.dev/router';
import { DEFAULT_METADATA_TITLE } from '~/constants';
import { generateDocumentHead } from '~/utils';
import { sanitizeStyle, sanitizeInlineScript } from '~/utils/sanitize';

interface HeadProps {
	nonce?: string;
}

export const Head = component$<HeadProps>(({ nonce }) => {
	const documentHead = useDocumentHead();
	const head =
		documentHead.meta.length > 0 ? documentHead : { ...documentHead, ...generateDocumentHead() };
	const loc = useLocation();

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
					font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
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
					color: #0F0F0F;
					background-color: #965341;
				}
			`}</style>

			{/* iPhone Advanced Privacy Protection compatibility */}
			<meta name="apple-mobile-web-app-capable" content="yes" />
			<meta name="apple-mobile-web-app-title" content="Damned Designs" />
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
			<link rel="dns-prefetch" href="https://gateway.sezzle.com" />
			<link rel="dns-prefetch" href="https://sandbox.gateway.sezzle.com" />


			{/* Geolocation services for address validation */}
			<link rel="dns-prefetch" href="https://ipapi.co" />
			<link rel="dns-prefetch" href="https://api.country.is" />
			<link rel="dns-prefetch" href="https://get.geojs.io" />



			{/* Service Worker for iOS privacy optimization */}
			<script
				{...(nonce ? { nonce } : {})}
				dangerouslySetInnerHTML={sanitizeInlineScript(`
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
			<title>{head.title || DEFAULT_METADATA_TITLE}</title>

			<link rel="manifest" href="/manifest.json" />
			{/* Font preloading - match actual LCP weights used above-the-fold */}
			<link rel="preload" href="/fonts/cormorant-garamond-v21-latin/cormorant-garamond-v21-latin-600.woff2" as="font" type="font/woff2" crossOrigin="anonymous" fetchPriority="high" />
			<link rel="preload" href="/fonts/cormorant-garamond-v21-latin/cormorant-garamond-v21-latin-700.woff2" as="font" type="font/woff2" crossOrigin="anonymous" fetchPriority="high" />
			<link rel="preload" href="/fonts/ibm-plex-sans-v23-latin/ibm-plex-sans-v23-latin-regular.woff2" as="font" type="font/woff2" crossOrigin="anonymous" fetchPriority="high" />
			<link rel="preload" href="/fonts/ibm-plex-sans-v23-latin/ibm-plex-sans-v23-latin-700.woff2" as="font" type="font/woff2" crossOrigin="anonymous" fetchPriority="high" />



			{/* Favicon — SVG only */}
			<link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml" />

			{/* Canonical: use page-specific if provided, otherwise default */}
			{head.links.some((l: any) => l.rel === 'canonical')
				? null
				: <link rel="canonical" href={`https://www.damneddesigns.com${loc.url.pathname}`} />
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

			{head.styles.map(({ key, style, ...props }) => (
				<style key={key} {...props} dangerouslySetInnerHTML={sanitizeStyle(style ?? '')} />
			))}
		</head>
	);
});
