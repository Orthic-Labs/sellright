// Per-host variants (src/brand/hosts.json): one storefront build served on several hosts, each rendered as its own variant
// (name, wordmark, canonical domain, catalog collection, CSS custom properties). Pure: the request Host in, a plain serialisable
// variant out. The license flow's layout resolves it once per request (routeLoader) and sets the tokens on its root element.
import { BRAND_HOSTS, type BrandHosts, type HostVariantSpec } from '~/platform/brand-data';

export interface HostVariant {
	key: string;
	name: string;
	wordmark: [string, string];
	domain: string;
	collection: string;
	description: string | null;
	ogImage: string | null;
	/** `--name:value;` for every token, in declaration order: the inline style of the variant root. */
	style: string;
}

/** Lower case, port and surrounding space dropped, then ONE leading label from `stripPrefixes` removed (`store.example.com` -> `example.com`). */
export function normalizeHost(host: string | null | undefined, stripPrefixes: readonly string[] = []): string {
	if (!host) return '';
	const bare = host.split(':')[0]!.trim().toLowerCase();
	const dot = bare.indexOf('.');
	return dot > 0 && stripPrefixes.includes(bare.slice(0, dot)) ? bare.slice(dot + 1) : bare;
}

/** The inline style of a variant root. Names and values are schema-checked (no `;`, braces, quotes or angle brackets). */
export function variantStyle(tokens: Readonly<Record<string, string>>): string {
	return Object.entries(tokens).map(([name, value]) => `${name}:${value};`).join('');
}

function project(spec: HostVariantSpec): HostVariant {
	return {
		key: spec.key,
		name: spec.name,
		wordmark: spec.wordmark ? [spec.wordmark[0], spec.wordmark[1]] : [spec.name, ''],
		domain: spec.domain,
		collection: spec.collection ?? spec.key,
		description: spec.description ?? null,
		ogImage: spec.ogImage ?? null,
		style: variantStyle(spec.tokens),
	};
}

/**
 * The variant for a request Host: the host itself (after normalising), else a variant whose key equals the normalised host (local
 * previews such as `viewright`), else the declared default. Null only when the brand declares no hosts.json.
 */
export function resolveHostVariant(host: string | null | undefined, data: BrandHosts | null = BRAND_HOSTS): HostVariant | null {
	if (!data) return null;
	const h = normalizeHost(host, data.stripPrefixes ?? []);
	const own = Object.prototype.hasOwnProperty.call(data.hosts, h) ? data.hosts[h] : undefined;
	const spec = own ?? Object.values(data.hosts).find((v) => v.key === h) ?? data.hosts[data.default]!;
	return project(spec);
}

/** The variant with this key (a license's app), or undefined. */
export function variantByKey(key: string, data: BrandHosts | null = BRAND_HOSTS): HostVariant | undefined {
	const spec = data ? Object.values(data.hosts).find((v) => v.key === key) : undefined;
	return spec ? project(spec) : undefined;
}
