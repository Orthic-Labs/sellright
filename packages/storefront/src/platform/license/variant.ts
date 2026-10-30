import type { DocumentHeadValue } from '@qwik.dev/router';
import { resolveHostVariant, type HostVariant } from '~/platform/host-variant';

/** Without src/brand/hosts.json the flow renders one variant from the build's store name and public domain. */
export function fallbackVariant(): HostVariant {
	const name = (import.meta.env.VITE_STORE_NAME as string | undefined) || 'Store';
	const domain = ((import.meta.env.VITE_PUBLIC_DOMAIN as string | undefined) || 'localhost').replace(/:\d+$/, '');
	return { key: 'store', name, wordmark: [name, ''], domain, collection: 'store', description: null, ogImage: null, style: '' };
}

export const variantForHost = (host: string | null | undefined): HostVariant => resolveHostVariant(host) ?? fallbackVariant();

/** `$29`, or `$29.50` when there are cents. */
export const fmtMoney = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/**
 * Head of a public license page: the title plus description, Open Graph and Twitter card tags (the stores had none, so a shared link
 * showed no text or image). The description defaults to the page's own promise; og:image only when the variant declares one.
 */
export function licensePageHead(v: HostVariant, title: string, url: URL): DocumentHeadValue {
	const description = v.description ?? `Buy a ${v.name} license. Secure checkout; your license key is delivered instantly after payment.`;
	const meta = [
		{ name: 'description', content: description },
		{ property: 'og:type', content: 'website' },
		{ property: 'og:site_name', content: v.name },
		{ property: 'og:title', content: title },
		{ property: 'og:description', content: description },
		{ property: 'og:url', content: `${url.origin}${url.pathname}` },
		{ name: 'twitter:card', content: v.ogImage ? 'summary_large_image' : 'summary' },
		...(v.ogImage ? [{ property: 'og:image', content: v.ogImage }] : []),
	];
	return { title, meta };
}
