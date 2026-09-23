import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';
import { theme, siteUrl } from '~/theme/theme.config';

export default component$(() => {
  return (
    <div class="bg-[var(--color-surface,#f4f4f5)] min-h-screen py-10 sm:py-14 lg:py-20">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">

        <h1 class="font-[var(--font-display)] text-4xl sm:text-5xl font-bold text-[var(--color-text,#18181b)] mb-8 leading-[1.05] tracking-tight">
          {theme.tagline}
        </h1>

        <div class="space-y-6 font-[var(--font-body)] text-[#3a3836] text-[15px] leading-[1.85]">

          <p>
            {theme.storeName} builds products around the same idea: good materials, careful
            construction, and pricing that doesn't require justification. No manufactured
            scarcity, no "limited edition" games — if something is good enough to make,
            it's good enough to keep in stock.
          </p>

          <h2 class="font-[var(--font-display)] text-2xl font-bold text-[var(--color-text,#18181b)] pt-4">
            The philosophy
          </h2>

          <p>
            <strong>Well-designed, well-made products should be accessible to more people.</strong>{' '}
            Not watered-down versions of expensive things — actually good products at prices
            that make sense.
          </p>

          <p>
            Function always comes first. Every product starts with how it works. Form
            matters, and striking a balance between the two is always the goal, but when
            there's a tradeoff, function wins.
          </p>

          <p class="text-[#706860] text-sm font-[var(--font-mono)] tracking-wide pt-4">
            Questions? <a href="/contact" class="text-[var(--color-accent)] hover:underline">Get in touch</a>.
          </p>

        </div>
      </div>
    </div>
  );
});

export const head = () => {
  return createSEOHead({
    title: `About ${theme.storeName}`,
    description: theme.tagline,
    canonical: `${siteUrl}/about/`,
    ogUrl: `${siteUrl}/about`,
    schemas: [
      {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        'name': `About ${theme.storeName}`,
        'url': `${siteUrl}/about`,
        'description': theme.tagline,
        'mainEntity': {
          '@type': 'Organization',
          'name': theme.storeName,
          'url': siteUrl,
          ...(theme.address ? { address: { '@type': 'PostalAddress', ...theme.address } } : {}),
        },
      },
    ],
  });
};
