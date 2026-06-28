// Homepage - Refined editorial design
import { component$, useStyles$, useSignal, useContext, $ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';
import { generateOrganizationSchema, generateWebsiteSchema } from '~/services/seo-api.service';
import { routeLoader$ } from '@qwik.dev/router';
import { APP_STATE } from '~/constants';
import { type LocalCartItem } from '~/services/LocalCartService';
import { useLocalCart, addToLocalCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { getProductBySlug } from '~/providers/shop/products/products';
import { STYLES } from '~/components/home/homepage-styles';
import { HomeHero } from '~/components/home/HomeHero';
import { HomeTeeSection } from '~/components/home/HomeTeeSection';
import { HomeReviewsSection, HomeServiceSection, HomeTrustBar } from '~/components/home/HomeSocialSections';

// Pre-order section image — 65: decorative/lifestyle, not a purchase decision image
import PreorderImage_480 from '~/media/sec2.jpg?format=avif&w=480&quality=65&url';
import PreorderImage_768 from '~/media/sec2.jpg?format=avif&w=768&quality=65&url';
import PreorderImage_1024 from '~/media/sec2.jpg?format=avif&w=1024&quality=65&url';
import PreorderImageWebP_480 from '~/media/sec2.jpg?format=webp&w=480&quality=70&url';
import PreorderImageWebP_768 from '~/media/sec2.jpg?format=webp&w=768&quality=70&url';
import PreorderImageWebP_1024 from '~/media/sec2.jpg?format=webp&w=1024&quality=70&url';
import PreorderImageJPEG_1024 from '~/media/sec2.jpg?format=jpeg&w=1024&quality=80&url';

/* ── Trustpilot data — reads local JSON file at runtime (updated by cron every 6 hours) ── */
const TP_FALLBACK = {
  score: '4.7',
  count: '298+',
  reviews: [
    { text: '"Absolutely amazing company with phenomenal customer service, fast shipping, and out of this world designs and products."', name: 'Jonathan Rivera' },
    { text: '"Quick shipping to the UK. Great quality knife. The Cerberus is great for gardening and food prep."', name: 'Modge' },
    { text: '"Great lil knives! Comfy and compact designs with great front flipper action. Shipping was quick."', name: 'Michael Sharp' },
    { text: '"Excellent quality and fast delivery. The knife arrived well packaged and looks even better in person."', name: 'David W.' },
    { text: '"Best EDC gear out there. Incredible build quality and the designs are absolutely unique."', name: 'Chris M.' },
    { text: '"Outstanding products. Already bought three items and will definitely be ordering again."', name: 'Taylor R.' },
  ],
};

// In-memory cache — loaded once on first request, auto-refreshes when cron updates file
let _tpCache: any = null;
let _tpWatching = false;

async function getTrustpilotData() {
  if (_tpCache) return _tpCache;
  try {
    const { readFileSync, watch } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const filePath = join(dir, '..', '..', 'src', 'data', 'trustpilot.json');
    _tpCache = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Watch for changes — re-read only when cron updates the file
    if (!_tpWatching) {
      _tpWatching = true;
      try {
        watch(filePath, () => {
          try { _tpCache = JSON.parse(readFileSync(filePath, 'utf-8')); }
          catch { /* keep existing cache */ }
        });
      } catch { /* fs.watch not available */ }
    }

    return _tpCache;
  } catch {
    return TP_FALLBACK;
  }
}

export const useTrustpilotData = routeLoader$(async () => {
  return getTrustpilotData();
});

/* ── Pre-order product data — fetched at SSR time ── */
export const usePreorderProduct = routeLoader$(async () => {
  try {
    const product = await getProductBySlug('pocket-fixed-blade');
    if (!product) return null;
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      featuredAsset: product.featuredAsset,
      variants: product.variants.map((v: any) => ({
        id: v.id,
        name: v.name,
        price: v.price,
        priceWithTax: v.priceWithTax,
        stockLevel: v.stockLevel,
        options: v.options,
        featuredAsset: v.featuredAsset,
        customFields: {
          preOrderPrice: v.customFields?.preOrderPrice,
          salePrice: v.customFields?.salePrice,
          shipDate: v.customFields?.shipDate,
          isPreOrder: v.customFields?.isPreOrder,
        },
      })),
    };
  } catch {
    return null;
  }
});

const BLADE_STYLES = ['Yokai', 'Basilisk', 'Fenrir'] as const;
const COLOR_OPTIONS = [
  { name: 'Black', cls: 'po-color-black' },
  { name: 'White', cls: 'po-color-white' },
  { name: 'Jade G10', cls: 'po-color-jade' },
] as const;

export default component$(() => {
  useStyles$(STYLES);

  const appState = useContext(APP_STATE);
  const localCart = useLocalCart();
  const tpData = useTrustpilotData();
  const preorderProduct = usePreorderProduct();
  const activeBlade = useSignal(0);
  const activeColor = useSignal(0);
  const isAddingToCart = useSignal(false);

  const nlEmail = useSignal('');
  const nlHoneypot = useSignal('');
  const nlState = useSignal<'idle' | 'sending' | 'success' | 'error'>('idle');
  const nlError = useSignal('');

  const handleNewsletterSubmit = $(async () => {
    if (nlState.value === 'sending') return;
    const email = nlEmail.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nlError.value = 'Please enter a valid email.';
      nlState.value = 'error';
      return;
    }
    nlState.value = 'sending';
    nlError.value = '';
    try {
      const res = await fetch('/newsletter-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          honeypot: nlHoneypot.value,
        }),
      });
      if (!res.ok) {
        const msg = res.status === 429 ? 'Too many signups from this IP. Try again in an hour.' : 'Subscription failed. Please try again.';
        nlError.value = msg;
        nlState.value = 'error';
        return;
      }
      nlState.value = 'success';
      nlEmail.value = '';
    } catch {
      nlError.value = 'Network error. Please try again.';
      nlState.value = 'error';
    }
  });

  const handlePreorderAddToCart = $(async () => {
    const product = preorderProduct.value;
    if (!product || isAddingToCart.value) return;

    isAddingToCart.value = true;
    try {
      const bladeName = BLADE_STYLES[activeBlade.value];
      const colorName = COLOR_OPTIONS[activeColor.value].name;
      // Map display color name to variant option name
      const handleMap: Record<string, string> = { 'Black': 'Black G10', 'White': 'White G10', 'Jade G10': 'Jade G10' };
      const handleName = handleMap[colorName] || colorName;

      // Find matching variant
      const variant = product.variants.find((v: any) =>
        v.options.some((o: any) => o.group?.name === 'Blade' && o.name === bladeName) &&
        v.options.some((o: any) => o.group?.name === 'Handle' && o.name === handleName)
      );

      if (!variant) {
        console.error('No variant found for', bladeName, handleName);
        isAddingToCart.value = false;
        return;
      }

      const localCartItem: LocalCartItem = {
        productVariantId: variant.id,
        quantity: 1,
        isPreOrder: true,
        shipDate: variant.customFields?.shipDate,
        preOrderPrice: variant.customFields?.preOrderPrice,
        productVariant: {
          id: variant.id,
          name: variant.name,
          price: variant.priceWithTax || variant.price || 0,
          stockLevel: variant.stockLevel,
          product: { id: product.id, name: product.name, slug: product.slug },
          options: variant.options || [],
          featuredAsset: variant.featuredAsset || product.featuredAsset,
        },
      };

      // Cart add via the context helper — respects the LocalCart vs ServerCart
      // strangler flag and dispatches the header-badge update itself.
      await addToLocalCart(localCart, localCartItem);
      localCart.hasLoadedOnce = true;
      appState.showCart = true;
      loadCountryOnDemand(appState);

      isAddingToCart.value = false;
    } catch (error) {
      console.error('Error adding pre-order to cart:', error);
      isAddingToCart.value = false;
    }
  });


  // T10: Scroll reveal via CSS animation-timeline (no UVT needed)
  // Elements with [data-reveal] animate via @keyframes hp-fade-reveal in global.css

  return (
    <div class="hp">
      <HomeHero tpData={tpData.value} />

      <HomeTrustBar />

      {/* ════════ Pre-order section ════════ */}
      <section class="preorder">
            <div>
              <div class="po-badge reveal visible"><span class="po-dot-green" />Now Taking Pre-Orders</div>
              <h2 class="po-title reveal visible" data-reveal>Pocket Fixed Blades</h2>
              <div class="po-specs reveal visible" data-reveal>3 Styles &middot; 3 Colors &middot; $40</div>
              <p class="po-sub reveal visible" data-reveal>
                Seven years of EDC obsession distilled into one carry. Three blade characters &mdash;
                Yokai, Basilisk, Fenrir &mdash; each available in Black, White, or Jade G10.
              </p>

              <div class="po-selector-label">Blade Style</div>
              <div class="po-styles" role="radiogroup" aria-label="Blade style selector">
                {BLADE_STYLES.map((name, i) => (
                  <button
                    key={name}
                    data-index={String(i)}
                    class={`po-style-btn ${activeBlade.value === i ? 'active' : ''}`}
                    onClick$={(e) => {
                      const el = (e.target as HTMLElement).closest('[data-index]') as HTMLElement | null;
                      if (el?.dataset.index) activeBlade.value = Number(el.dataset.index);
                    }}
                    role="radio"
                    aria-checked={activeBlade.value === i}
                  >{name}</button>
                ))}
              </div>

              <div class="po-selector-label">Color</div>
              <div class="po-colors" role="radiogroup" aria-label="Color selector">
                {COLOR_OPTIONS.map((c, i) => (
                  <button
                    key={c.name}
                    data-index={String(i)}
                    class={`po-color-swatch ${c.cls} ${activeColor.value === i ? 'active' : ''}`}
                    onClick$={(e) => {
                      const el = (e.target as HTMLElement).closest('[data-index]') as HTMLElement | null;
                      if (el?.dataset.index) activeColor.value = Number(el.dataset.index);
                    }}
                    role="radio"
                    aria-checked={activeColor.value === i}
                    aria-label={c.name}
                    title={c.name}
                  />
                ))}
              </div>

              <div class="po-price">$40 USD</div>

              <div class="po-actions">
                <button
                  class="btn-primary"
                  onClick$={handlePreorderAddToCart}
                  disabled={isAddingToCart.value}
                  aria-label={`Add to Cart – ${BLADE_STYLES[activeBlade.value]} ${COLOR_OPTIONS[activeColor.value].name}`}
                >
                  {isAddingToCart.value ? 'Adding...' : 'Add to Cart'} <span class="btn-arrow">&rarr;</span>
                </button>
                <a href="/products/pocket-fixed-blade" class="btn-ghost--dark">View Details</a>
              </div>
            </div>
            <div class="preorder-img-cell">
              <div class="po-img-wrap">
                <picture>
                  <source type="image/avif" srcset={`${PreorderImage_480} 480w, ${PreorderImage_768} 768w, ${PreorderImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                  <source type="image/webp" srcset={`${PreorderImageWebP_480} 480w, ${PreorderImageWebP_768} 768w, ${PreorderImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                  <img src={PreorderImageJPEG_1024} alt="Pocket Fixed Blade lineup - 3 styles, 3 colorways"
                    loading="lazy" decoding="async" width={1024} height={1280} class="po-img" />
                </picture>
              </div>
            </div>
      </section>

      <HomeTeeSection />

      <HomeReviewsSection tpData={tpData.value} />

      <HomeServiceSection />

      {/* ════════ Newsletter ════════ */}
      <section class="newsletter">
          <div data-reveal>
            <div class="nl-label">Stay Sharp</div>
            <div class="nl-title">New drops. Restocks. No spam.</div>
            <div class="nl-sub">Be the first to know when new products drop and restocks happen. One email, no fluff.</div>
            <form
              class="nl-form"
              preventdefault:submit
              onSubmit$={handleNewsletterSubmit}
              aria-label="Newsletter signup"
            >
              <input
                type="text"
                name="website"
                value={nlHoneypot.value}
                onInput$={(_, el) => { nlHoneypot.value = el.value; }}
                style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
              />
              <input
                type="email"
                class="nl-input"
                placeholder="your@email.com"
                aria-label="Email address"
                value={nlEmail.value}
                onInput$={(_, el) => { nlEmail.value = el.value; }}
                required
                disabled={nlState.value === 'sending'}
              />
              <button
                type="submit"
                class="nl-submit"
                disabled={nlState.value === 'sending'}
              >
                {nlState.value === 'sending' ? 'Subscribing…' : nlState.value === 'success' ? 'Subscribed ✓' : 'Subscribe'}
              </button>
            </form>
            {nlState.value === 'error' && (
              <p style="color:#ff6b6b;font-size:13px;margin-top:12px;font-family:var(--font-body);">{nlError.value}</p>
            )}
            {nlState.value === 'success' && (
              <p style="color:var(--accent-light);font-size:13px;margin-top:12px;font-family:var(--font-body);">Subscribed ✓ — see you in your inbox soon</p>
            )}
          </div>
      </section>
    </div>
  );
});

export const head = () => {
  const organizationSchema = generateOrganizationSchema();
  const websiteSchema = generateWebsiteSchema();

  return createSEOHead({
    title: 'Precision EDC',
    description: 'Quality EDC folding knives, fixed blade knives, and everyday tools that prove exceptional craftsmanship doesn\'t require exceptional prices. Pocket knives, kitchen knives, lanyard beads, and fidget spinners.',
    noindex: false,
    image: 'https://www.damneddesigns.com/social-image.jpg',
    ogUrl: 'https://www.damneddesigns.com/',
    links: [
      { rel: 'preload', as: 'image', type: 'image/avif', href: HeroImage_1024 },
    ],
    schemas: [organizationSchema, websiteSchema],
  });
};

import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
