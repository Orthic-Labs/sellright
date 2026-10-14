// Brand views, plan §2.4: the document head a brand can shape through DATA (src/brand/head.json, routes.json), never code.
// The pure logic (BrandHeadSpec, resolveHead, contentHead, canonicalHref, analyticsCsp) lives in head-resolve.ts and is re-exported
// here; this file adds `brandHeadTags`, which renders everything brand-declared that the base head does not.
import { DEFAULT_SOURCES, type ResolvedHead } from './head-resolve';
import { GTM_LOADER_SOURCE } from './head-analytics';

export type { BrandHeadSpec, StaticSchema, ExtraLink, ResolvedHead, HeadSources } from './head-resolve';
export type { AnalyticsCsp } from './head-analytics';
export { canonicalHref, contentHead, DEFAULT_SOURCES, resolveHead, serialiseJsonLd, setMeta } from './head-resolve';
export { analyticsCsp, GTM_LOADER_SOURCE } from './head-analytics';

/**
 * Everything brand-declared that the base head does not render: preloads, verification, static JSON-LD, the analytics loader.
 * A PLAIN FUNCTION returning elements, not a component: a component boundary would add Qwik's virtual-node markers to the head, and
 * the head must be byte-identical to today's when nothing is declared (an empty array renders nothing).
 */
export function brandHeadTags(resolved: ResolvedHead, nonce?: string) {
	const spec = DEFAULT_SOURCES.spec;
	const tags = [
		...resolved.extraLinks.map((l) => (
			<link key={`${l.as}:${l.href}`} rel={l.rel} as={l.as} type={l.type} href={l.href} crossOrigin={l.crossOrigin} imageSrcset={l.imagesrcset} imageSizes={l.imagesizes} fetchPriority={l.fetchpriority} />
		)),
		...(spec.verification?.facebookDomain ? [<meta key="fb-domain" name="facebook-domain-verification" content={spec.verification.facebookDomain} />] : []),
		...(spec.verification?.pinterest ? [<meta key="p-domain" name="p:domain_verify" content={spec.verification.pinterest} />] : []),
		...resolved.extraJsonLd.map((json, i) => <script key={`brand-jsonld-${i}`} type="application/ld+json" dangerouslySetInnerHTML={json} />),
		// consent 'implied' only: a 'required' declaration loads nothing until a consent source exists (none yet, plan §6.5)
		...(spec.analytics?.provider === 'gtm' && spec.analytics.consent === 'implied'
			? [<script key="gtm" {...(nonce ? { nonce } : {})} data-gtm-id={spec.analytics.containerId} dangerouslySetInnerHTML={GTM_LOADER_SOURCE} />]
			: []),
	];
	return tags;
}
