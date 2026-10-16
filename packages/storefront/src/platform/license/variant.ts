import { resolveHostVariant, type HostVariant } from '~/platform/host-variant';

/** Without src/brand/hosts.json the flow renders one variant from the build's store name and public domain. */
export function fallbackVariant(): HostVariant {
	const name = (import.meta.env.VITE_STORE_NAME as string | undefined) || 'Store';
	const domain = ((import.meta.env.VITE_PUBLIC_DOMAIN as string | undefined) || 'localhost').replace(/:\d+$/, '');
	return { key: 'store', name, wordmark: [name, ''], domain, collection: 'store', style: '' };
}

export const variantForHost = (host: string | null | undefined): HostVariant => resolveHostVariant(host) ?? fallbackVariant();

/** `$29`, or `$29.50` when there are cents. */
export const fmtMoney = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
