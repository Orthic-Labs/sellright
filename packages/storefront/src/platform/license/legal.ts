// License flow legal data (src/brand/license.json): the acceptance contract per app (the API rejects any checkout whose
// documents differ from its canonical manifests, so the brand file is resynced whenever a manifest changes), the point-of-sale
// links on the app's canonical domain, and the confirmation page's links.
import { BRAND_LICENSE, type BrandLicense, type LegalLinks, type LicenseContract } from '~/platform/brand-data';

export type CheckoutEligibilityBasis = 'individual' | 'enterprise';

export function checkoutLegalContract(appKey: string | null | undefined, data: BrandLicense | null = BRAND_LICENSE): LicenseContract | null {
	if (!appKey) return null;
	const contracts = data?.contracts ?? {};
	const key = appKey.toLowerCase();
	return Object.prototype.hasOwnProperty.call(contracts, key) ? contracts[key]! : null;
}

/** Checkout legal links: absolute, on the app's canonical domain (the store subdomain does not serve them). */
export function legalLinks(domain: string) {
	const base = `https://${domain}`;
	return {
		privacy: `${base}/privacy/`, terms: `${base}/terms/`, refund: `${base}/refund/`, contact: `${base}/contact/`,
		license: `${base}/legal/license/`, eula: `${base}/legal/eula/`, acceptableUse: `${base}/legal/acceptable-use/`,
		productSchedule: `${base}/legal/product-schedule/`, thirdParty: `${base}/legal/third-party/`,
	};
}

const CONFIRMATION_DEFAULT: LegalLinks = { privacy: '/privacy', terms: '/terms', refund: '/refund', contact: '/contact' };

/** Confirmation page links: the variant's own entry, else the brand's `default` entry, else the built-in relative paths. */
export function confirmationLegalLinks(variantKey: string, data: BrandLicense | null = BRAND_LICENSE): LegalLinks {
	const links = data?.confirmationLegalLinks ?? {};
	const own = Object.prototype.hasOwnProperty.call(links, variantKey) ? links[variantKey] : undefined;
	return own ?? links.default ?? CONFIRMATION_DEFAULT;
}

/** Apps whose checkout is paused (nothing deliverable yet): a direct checkout link shows "nothing to check out". */
export const isCheckoutPaused = (appKey: string | null | undefined, data: BrandLicense | null = BRAND_LICENSE): boolean =>
	!!appKey && (data?.pausedAppKeys ?? []).includes(appKey);

export const sellerLine = (data: BrandLicense | null = BRAND_LICENSE): string => data?.seller.line ?? '';
export const supportEmailFor = (domain: string, data: BrandLicense | null = BRAND_LICENSE): string => `${data?.seller.supportLocalPart ?? 'support'}@${domain}`;
