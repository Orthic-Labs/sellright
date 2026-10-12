// Brand views, plan §2.4 "Analytics and CSP": the CSP origins and the GTM loader for head.json `analytics`. A small module of its own so the
// Express entry can import `analyticsCsp` without pulling in the head resolver. Pure.
import type { BrandHeadSpec } from './head-resolve';

export interface AnalyticsCsp {
	script: string[];
	connect: string[];
}

/** CSP additions for the declared analytics (Google's GTM CSP guide, checked 2026-10-12). No `unsafe-eval`. */
export function analyticsCsp(analytics: BrandHeadSpec['analytics'] | undefined): AnalyticsCsp | undefined {
	if (!analytics) return undefined;
	return {
		script: ['https://*.googletagmanager.com'],
		connect: ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'],
	};
}

/**
 * The GTM loader (Google's snippet, nonce'd): a STATIC script. It takes the container id from its own `data-gtm-id` attribute (validated
 * at build as `^GTM-[A-Z0-9]{4,12}$`, escaped by the JSX attribute), so no code is built from data.
 */
export const GTM_LOADER_SOURCE =
	"(function(w,d,s,l){var c=d.currentScript,i=c&&c.getAttribute('data-gtm-id');if(!i)return;w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+encodeURIComponent(i);if(c.nonce){j.setAttribute('nonce',c.nonce);}f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer');";
