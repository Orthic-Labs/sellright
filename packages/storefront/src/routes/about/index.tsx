import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';

export default component$(() => {
  return (
    <div class="bg-[#F7F2EA] min-h-screen py-10 sm:py-14 lg:py-20">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">

        <h1 class="font-['Cormorant_Garamond'] text-4xl sm:text-5xl font-bold text-[#111110] mb-8 leading-[1.05] tracking-tight">
          Good design shouldn't<br />be a luxury.
        </h1>

        <div class="space-y-6 font-['IBM_Plex_Sans'] text-[#3a3836] text-[15px] leading-[1.85]">

          <p>
            Damned Designs started in 2017 with a fidget spinner called the Triad.
            What followed was an obsessive run of dozens of spinner designs — more than
            any other maker in the space — each one pushing materials, tolerances, and
            what a small operation could pull off.
          </p>

          <p>
            By 2019, the focus shifted to knives and EDC. The early models used premium
            materials — M390 steel, titanium frames — but the real breakthrough came with
            the Oni, a mini pocket knife that proved you could deliver serious design in a
            compact, affordable package. The "budget" full-sized folders that followed in
            2020 built on that same idea: give people a knife that punches way above its
            price point.
          </p>

          <h2 class="font-['Cormorant_Garamond'] text-2xl font-bold text-[#111110] pt-4">
            The philosophy
          </h2>

          <p>
            <strong>Well-designed, well-made products should be accessible to more people.</strong>{' '}
            That's the whole point of Damned Designs. Not watered-down versions of expensive
            things — actually good products at prices that don't require justification.
            Quality at unreal prices. That's the bar.
          </p>

          <p>
            There are no drops here. No manufactured scarcity. No "limited edition" games
            to create artificial urgency. If a design is good enough to make, it's good
            enough to keep in stock.
          </p>

          <p>
            And function always comes first. Every design starts with how it works — the
            action, the ergonomics, the steel, the lock. Form matters, and striking a
            balance between the two is always the goal, but when there's a tradeoff,
            function wins. Every time.
          </p>

          <h2 class="font-['Cormorant_Garamond'] text-2xl font-bold text-[#111110] pt-4">
            Based in New York. Ships from California.
          </h2>

          <p>
            Damned Designs is a registered company out of New York, with fulfillment from
            California. Every product is designed in-house and manufactured to spec with
            factories that have been vetted over years of iteration.
          </p>

          <p class="text-[#706860] text-sm font-['IBM_Plex_Mono'] tracking-wide pt-4">
            Questions? <a href="/contact" class="text-[#965341] hover:underline">Get in touch</a>.
          </p>

        </div>
      </div>
    </div>
  );
});

export const head = () => {
  return createSEOHead({
    title: 'About Damned Designs',
    description: 'Damned Designs makes well-designed EDC knives and gear at accessible prices. No drops, no scarcity games. Good design for everyone.',
    canonical: 'https://www.damneddesigns.com/about/',
    ogUrl: 'https://www.damneddesigns.com/about',
    schemas: [
      {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        'name': 'About Damned Designs',
        'url': 'https://www.damneddesigns.com/about',
        'description': 'Damned Designs makes well-designed EDC knives and gear at accessible prices.',
        'mainEntity': {
          '@type': 'Organization',
          'name': 'Damned Designs',
          'url': 'https://www.damneddesigns.com',
          'foundingDate': '2017',
          'founder': {
            '@type': 'Person',
            'name': 'Adrian D\'Souza',
          },
          'address': {
            '@type': 'PostalAddress',
            'streetAddress': '169 Madison Ave #2484',
            'addressLocality': 'New York',
            'addressRegion': 'NY',
            'postalCode': '10016',
            'addressCountry': 'US',
          },
        },
      },
    ],
  });
};
