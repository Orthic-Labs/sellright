/**
 * #388: the business facts behind the storefront's search-result data (Organization, WebSite search, Product offer
 * shipping and returns), edited on the SEO page and saved through PATCH /v1/admin/seo/config. Pure: form <-> patch.
 */
export interface SeoDetailsConfig {
  organization: {
    name: string; logo: string | null; sameAs: string[]; image: string | null; description: string | null; telephone: string | null;
    founder: { name: string; id: string | null } | null;
    address: { streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string; addressCountry?: string } | null;
  };
  searchPath: string | null;
  shipping: { rate: string; country: string; handling: { min: number; max: number } | null; transit: { min: number; max: number } | null } | null;
  returns: { days: number; country: string; fees: 'customer' | 'free' } | null;
}

export interface SeoDetailsForm {
  name: string; logo: string; image: string; description: string; telephone: string; founderName: string; founderUrl: string;
  street: string; city: string; region: string; postalCode: string; country: string; sameAs: string;
  searchPath: string;
  shipRate: string; shipCountry: string; handlingMin: string; handlingMax: string; transitMin: string; transitMax: string;
  returnDays: string; returnCountry: string; returnFees: 'customer' | 'free';
}

const s = (v: string | null | undefined) => v ?? '';
const n = (v: number | null | undefined) => (v == null ? '' : String(v));

export function seoDetailsForm(c: SeoDetailsConfig): SeoDetailsForm {
  const o = c.organization; const a = o.address ?? {};
  return {
    name: s(o.name), logo: s(o.logo), image: s(o.image), description: s(o.description), telephone: s(o.telephone),
    founderName: s(o.founder?.name), founderUrl: s(o.founder?.id),
    street: s(a.streetAddress), city: s(a.addressLocality), region: s(a.addressRegion), postalCode: s(a.postalCode), country: s(a.addressCountry),
    sameAs: o.sameAs.join('\n'), searchPath: s(c.searchPath),
    shipRate: s(c.shipping?.rate), shipCountry: s(c.shipping?.country), handlingMin: n(c.shipping?.handling?.min), handlingMax: n(c.shipping?.handling?.max),
    transitMin: n(c.shipping?.transit?.min), transitMax: n(c.shipping?.transit?.max),
    returnDays: n(c.returns?.days), returnCountry: s(c.returns?.country), returnFees: c.returns?.fees ?? 'customer',
  };
}

const t = (v: string) => v.trim();
const orNull = (v: string) => (t(v) ? t(v) : null);
const range = (min: string, max: string): [number, number] | undefined => (t(min) && t(max) ? [Number(min), Number(max)] : undefined);

/** The PATCH body for the form: blank fields clear; shipping/returns are sent whole, or null when their key field is blank. */
export function seoDetailsPatch(f: SeoDetailsForm) {
  const address = { streetAddress: t(f.street), addressLocality: t(f.city), addressRegion: t(f.region), postalCode: t(f.postalCode), addressCountry: t(f.country) };
  const addr = Object.fromEntries(Object.entries(address).filter(([, v]) => v));
  return {
    organization: {
      name: t(f.name), logo: orNull(f.logo), image: orNull(f.image), description: orNull(f.description), telephone: orNull(f.telephone),
      founder: t(f.founderName) ? { name: t(f.founderName), ...(t(f.founderUrl) ? { id: t(f.founderUrl) } : {}) } : null,
      address: Object.keys(addr).length ? addr : null,
      sameAs: f.sameAs.split(/\r?\n/).map(t).filter(Boolean),
    },
    searchPath: orNull(f.searchPath),
    shipping: t(f.shipRate) ? {
      rate: t(f.shipRate), country: t(f.shipCountry).toUpperCase(),
      ...(range(f.handlingMin, f.handlingMax) ? { handlingDays: range(f.handlingMin, f.handlingMax) } : {}),
      ...(range(f.transitMin, f.transitMax) ? { transitDays: range(f.transitMin, f.transitMax) } : {}),
    } : null,
    returns: t(f.returnDays) ? { days: Number(f.returnDays), country: t(f.returnCountry).toUpperCase(), fees: f.returnFees } : null,
  };
}
