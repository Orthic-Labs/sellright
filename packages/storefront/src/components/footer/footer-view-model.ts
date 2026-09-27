import type { SrStoreIdentity } from '~/utils/sellright';

/**
 * WS-C: pure derivation of the identity-dependent footer content, kept
 * framework-free (no Qwik/router imports) so it's importable from a plain
 * vitest test (see src/two-store-identity.test.ts — asserts two stores'
 * footers differ) without pulling in the whole Qwik Router virtual-module
 * graph that a real component file transitively depends on. footer.tsx
 * calls this same function, so a test proving it changes per-identity is
 * proving the actual rendered output changes too, not a parallel
 * reimplementation.
 */
export function footerViewModel(identity: SrStoreIdentity, year: number = new Date().getFullYear()) {
	const link = (href: string | undefined, network: string) =>
		href ? { href, ariaLabel: `${identity.storeName} on ${network}` } : null;
	return {
		copyright: `© ${year} ${identity.legalName}. All rights reserved.`,
		social: {
			instagram: link(identity.social.instagram, 'Instagram'),
			facebook: link(identity.social.facebook, 'Facebook'),
			twitter: link(identity.social.twitter, 'Twitter'),
		},
	};
}
