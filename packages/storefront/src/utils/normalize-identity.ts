import { identityFromStaticTheme } from '~/theme/theme.config';
import type { SrStoreIdentity } from '~/utils/sellright';

/**
 * Defense-in-depth against API/storefront version skew (e.g. a rolling
 * deploy where the storefront image updates before/after the API image, or
 * a load balancer briefly routing to an older API instance): `sr()` casts
 * the fetched JSON to `SrStoreIdentity` with no runtime schema validation,
 * so a response missing a field this build expects (added in a later
 * release, e.g. `policies`) would otherwise reach every consumer as
 * `undefined` and crash on first property access (`identity.policies.shipping`).
 * Deep-merges the fetched identity over the static fallback, per nested
 * object, so a partial/older response degrades to sane defaults for the
 * fields it's missing instead of crashing the whole page.
 *
 * Kept in its own framework-free module (no Qwik/router imports) so it's
 * importable from a plain vitest test — see normalize-identity.test.ts —
 * without pulling in the Qwik Router virtual-module graph that
 * routes/layout.tsx (a real route file) transitively depends on.
 */
export function normalizeIdentity(fetched: SrStoreIdentity): SrStoreIdentity {
	const fallback = identityFromStaticTheme();
	return {
		...fallback,
		...fetched,
		social: { ...fallback.social, ...(fetched.social ?? {}) },
		colors: { ...fallback.colors, ...(fetched.colors ?? {}) },
		fonts: { ...fallback.fonts, ...(fetched.fonts ?? {}) },
		policies: {
			shipping: { ...fallback.policies.shipping, ...(fetched.policies?.shipping ?? {}) },
			returns: { ...fallback.policies.returns, ...(fetched.policies?.returns ?? {}) },
			payment: { ...fallback.policies.payment, ...(fetched.policies?.payment ?? {}) },
		},
		address: fetched.address ?? fallback.address,
	};
}
