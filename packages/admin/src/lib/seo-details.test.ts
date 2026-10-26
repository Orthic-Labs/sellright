import { describe, expect, it } from 'vitest';
import { seoDetailsForm, seoDetailsPatch, type SeoDetailsConfig } from './seo-details';

const cfg: SeoDetailsConfig = {
  organization: { name: 'Damned Designs', logo: 'https://x.test/logo.png', sameAs: ['https://facebook.com/dd'], image: null, description: 'Knives',
    telephone: null, founder: { name: 'Adrian', id: null }, address: { addressLocality: 'Austin', addressCountry: 'US' } },
  searchPath: '/shop',
  shipping: { rate: '8.00', country: 'US', handling: { min: 1, max: 3 }, transit: { min: 3, max: 7 } },
  returns: { days: 7, country: 'US', fees: 'customer' },
};

describe('SEO business details (#388)', () => {
  it('round-trips the saved config into the PATCH body shape', () => {
    expect(seoDetailsPatch(seoDetailsForm(cfg))).toEqual({
      organization: { name: 'Damned Designs', logo: 'https://x.test/logo.png', image: null, description: 'Knives', telephone: null,
        founder: { name: 'Adrian' }, address: { addressLocality: 'Austin', addressCountry: 'US' }, sameAs: ['https://facebook.com/dd'] },
      searchPath: '/shop',
      shipping: { rate: '8.00', country: 'US', handlingDays: [1, 3], transitDays: [3, 7] },
      returns: { days: 7, country: 'US', fees: 'customer' },
    });
  });

  it('blank fields clear: no shipping without a rate, no returns without days, no address without any line', () => {
    const f = { ...seoDetailsForm(cfg), shipRate: ' ', returnDays: '', city: '', country: '', searchPath: '', founderName: '' };
    const p = seoDetailsPatch(f);
    expect([p.shipping, p.returns, p.searchPath, p.organization.founder, p.organization.address]).toEqual([null, null, null, null, null]);
  });
});
