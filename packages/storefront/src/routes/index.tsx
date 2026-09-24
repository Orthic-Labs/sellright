// Homepage - Refined editorial design
import { component$, useStyles$, useSignal, useContext, $ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';
import { jsonLdOrganization } from '~/services/sellright-seo';
import type { JsonLdSchema } from '~/types/seo.types';
import { routeLoader$ } from '@qwik.dev/router';
import { APP_STATE } from '~/constants';
import { type LocalCartItem } from '~/services/LocalCartService';
import { useLocalCart, addToLocalCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { getProductBySlug, search } from '~/providers/shop/products/products';
import { srCollections } from '~/utils/sellright';
import { stripHtml } from '~/utils/sanitize';
import { STYLES } from '~/components/home/homepage-styles';
import { HomeHero } from '~/components/home/HomeHero';
import { HomeTeeSection } from '~/components/home/HomeTeeSection';
import { HomeServiceSection, HomeTrustBar } from '~/components/home/HomeSocialSections';
import Price from '~/components/products/Price';
import ProductCard from '~/components/products/ProductCard';
import { theme, siteUrl } from '~/theme/theme.config';
import HeroImage_1024 from '~/media/hero.jpg?format=avif&w=1024&quality=75&url';

// Spotlight section image — 65: decorative/lifestyle, not a purchase decision image
import PreorderImage_480 from '~/media/sec2.jpg?format=avif&w=480&quality=65&url';
import PreorderImage_768 from '~/media/sec2.jpg?format=avif&w=768&quality=65&url';
import PreorderImage_1024 from '~/media/sec2.jpg?format=avif&w=1024&quality=65&url';
import PreorderImageWebP_480 from '~/media/sec2.jpg?format=webp&w=480&quality=70&url';
import PreorderImageWebP_768 from '~/media/sec2.jpg?format=webp&w=768&quality=70&url';
import PreorderImageWebP_1024 from '~/media/sec2.jpg?format=webp&w=1024&quality=70&url';
import PreorderImageJPEG_1024 from '~/media/sec2.jpg?format=jpeg&w=1024&quality=80&url';

/* Optional homepage spotlight product — configure VITE_HOME_SPOTLIGHT_SLUG to
 * feature a real catalog item. Unset by default so a fresh install never
 * ships a broken/fabricated product reference. */
const SPOTLIGHT_PRODUCT_SLUG = (import.meta.env.VITE_HOME_SPOTLIGHT_SLUG as string | undefined) || '';

/* Optional second homepage product for the "New Arrival" strip
 * (HomeTeeSection) — configure VITE_HOME_FEATURE_SLUG to a DIFFERENT catalog
 * item than VITE_HOME_SPOTLIGHT_SLUG so the two sections never feature the
 * same product back-to-back. If unset (or accidentally equal to the
 * spotlight slug) HomeTeeSection falls back to its generic, product-less
 * "New arrivals." copy rather than repeating the spotlight product. */
const FEATURE_PRODUCT_SLUG = (import.meta.env.VITE_HOME_FEATURE_SLUG as string | undefined) || '';

// Organization + WebSite JSON-LD proxied live from the SellRight API
// (/v1/shop/seo/jsonld/organization) — never generated locally from
// theme.config.ts, so the schema always matches whatever the backend store
// config says (siteUrl, address, social links, etc).
export const useOrganizationJsonLd = routeLoader$(async () => jsonLdOrganization());

async function fetchHomeProduct(slug: string) {
  if (!slug) return null;
  try {
    const product = await getProductBySlug(slug);
    if (!product) return null;
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      // Plain-text category label for the featured-product spec row (e.g.
      // seed tags ['demo','desk'] -> 'Desk'). Never fabricate material/fit/
      // finish claims — show only what the product's own data says.
      category: (product.facetValues || []).map((f: any) => f.name).find((t: string) => t !== 'demo') || null,
      description: product.description || null,
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
}

export const usePreorderProduct = routeLoader$(async () => fetchHomeProduct(SPOTLIGHT_PRODUCT_SLUG));

// Distinct from usePreorderProduct on purpose — same slug would render the
// same product in both the spotlight section AND HomeTeeSection.
export const useFeatureProduct = routeLoader$(async () => {
  if (!FEATURE_PRODUCT_SLUG || FEATURE_PRODUCT_SLUG === SPOTLIGHT_PRODUCT_SLUG) return null;
  return fetchHomeProduct(FEATURE_PRODUCT_SLUG);
});

/** Live storefront catalog — 4 tiles, same data/shape as the shop grid
 * (adaptSearch), so a demo/fresh install always has real, honest product
 * tiles here rather than a hand-picked slug that might not exist yet. */
export const useFeaturedProducts = routeLoader$(async () => {
  try {
    const res = await search({ take: 4 });
    return (res?.items ?? []).slice(0, 4);
  } catch {
    return [];
  }
});

/** Collection links (Desk & Paper / Everyday Carry / At Home on the seeded
 * demo catalog) — whatever the store actually has, never a hardcoded list. */
export const useHomeCollections = routeLoader$(async () => {
  try {
    const res = await srCollections();
    return (res?.items ?? []).filter((c) => c.products > 0).slice(0, 6);
  } catch {
    return [];
  }
});

export default component$(() => {
  useStyles$(STYLES);

  const appState = useContext(APP_STATE);
  const localCart = useLocalCart();
  const preorderProduct = usePreorderProduct();
  const featureProduct = useFeatureProduct();
  const featuredProducts = useFeaturedProducts();
  const homeCollections = useHomeCollections();
  const isAddingToCart = useSignal(false);

  const spotlightVariant = preorderProduct.value
    ? preorderProduct.value.variants.find((v: any) => v.stockLevel !== 'OUT_OF_STOCK') || preorderProduct.value.variants[0]
    : null;
  const featureVariant = featureProduct.value
    ? featureProduct.value.variants.find((v: any) => v.stockLevel !== 'OUT_OF_STOCK') || featureProduct.value.variants[0]
    : null;
  // Spotlight body copy: the product's OWN description, never the site
  // tagline — theme.tagline is generic storefront copy and was leaking in
  // here as a fallback, which is wrong for every configured spotlight
  // product. No fallback text when a product has no description; the
  // paragraph simply doesn't render rather than showing something untrue.
  const spotlightBody = preorderProduct.value?.description ? stripHtml(preorderProduct.value.description).trim() : '';

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
      // Generic spotlight CTA — adds the first enabled variant. Stores that
      // need per-variant selection on the homepage should link to the PDP
      // (which has full variant selection) rather than duplicate that UI here.
      const variant = product.variants.find((v: any) => v.stockLevel !== 'OUT_OF_STOCK') || product.variants[0];

      if (!variant) {
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
      <HomeHero />

      <HomeTrustBar />

      {/* ════════ Spotlight section (only renders when a real product is configured) ════════ */}
      {preorderProduct.value && (
        <section class="preorder">
              <div>
                <div class="po-badge reveal visible"><span class="po-dot-green" />Featured</div>
                <h2 class="po-title reveal visible" data-reveal>{preorderProduct.value.name}</h2>
                {spotlightVariant && (
                  <div class="po-price-wrap">
                    <Price
                      priceWithTax={spotlightVariant.priceWithTax ?? spotlightVariant.price}
                      salePrice={spotlightVariant.customFields?.salePrice}
                      preOrderPrice={spotlightVariant.customFields?.preOrderPrice}
                      isPreOrder={spotlightVariant.customFields?.isPreOrder}
                      forcedClass="po-price"
                    />
                  </div>
                )}
                {spotlightBody && (
                  <p class="po-sub reveal visible" data-reveal>
                    {spotlightBody}
                  </p>
                )}

                <div class="po-actions">
                  <button
                    class="btn-primary"
                    onClick$={handlePreorderAddToCart}
                    disabled={isAddingToCart.value}
                    aria-label={`Add ${preorderProduct.value.name} to cart`}
                  >
                    {isAddingToCart.value ? 'Adding...' : 'Add to Cart'} <span class="btn-arrow">&rarr;</span>
                  </button>
                  <a href={`/products/${preorderProduct.value.slug}`} class="btn-ghost--dark">View Details</a>
                </div>
              </div>
              <div class="preorder-img-cell">
                <div class="po-img-wrap">
                  {preorderProduct.value.featuredAsset?.preview ? (
                    <img src={`${preorderProduct.value.featuredAsset.preview}?preset=large`} alt={`${preorderProduct.value.name} — featured product`}
                      loading="lazy" decoding="async" width={1024} height={1280} class="po-img" />
                  ) : (
                    <picture>
                      <source type="image/avif" srcset={`${PreorderImage_480} 480w, ${PreorderImage_768} 768w, ${PreorderImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                      <source type="image/webp" srcset={`${PreorderImageWebP_480} 480w, ${PreorderImageWebP_768} 768w, ${PreorderImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                      <img src={PreorderImageJPEG_1024} alt={`${preorderProduct.value.name} — featured product`}
                        loading="lazy" decoding="async" width={1024} height={1280} class="po-img" />
                    </picture>
                  )}
                </div>
              </div>
        </section>
      )}

      <HomeTeeSection product={featureProduct.value} variant={featureVariant} />

      {/* ════════ Shop the collection — live catalog grid ════════ */}
      {featuredProducts.value.length > 0 && (
        <section class="featured-grid">
          <div class="featured-grid-head" data-reveal>
            <div class="tee-label">Shop the collection</div>
            <h2 class="featured-grid-title">Everything, considered.</h2>
          </div>
          <div class="featured-grid-items">
            {featuredProducts.value.map((item: any, i: number) => (
              <ProductCard
                key={item.slug}
                productAsset={item.productAsset}
                productName={item.productName}
                slug={item.slug}
                priceWithTax={item.priceWithTax}
                inStock={item.inStock}
                priority={i < 4}
              />
            ))}
          </div>
          {homeCollections.value.length > 0 && (
            <div class="featured-collections" data-reveal>
              {homeCollections.value.map((c) => (
                <a key={c.slug} href={`/collections/${c.slug}/`} class="featured-collection-link">
                  {c.name} <span class="btn-arrow">&rarr;</span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      <HomeServiceSection />

      {/* ════════ Newsletter ════════ */}
      <section class="newsletter">
          <div data-reveal>
            <div class="nl-label">Stay in the loop</div>
            <div class="nl-title">New arrivals. Restocks. No spam.</div>
            <div class="nl-sub">Be the first to know about new arrivals and restocks. One email, no fluff.</div>
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

export const head = ({ resolveValue }: { resolveValue: any }) => {
  const schemas = resolveValue(useOrganizationJsonLd) as unknown as JsonLdSchema[];

  return createSEOHead({
    title: theme.storeName,
    description: theme.tagline,
    noindex: false,
    image: `${siteUrl}${theme.ogImageUrl}`,
    ogUrl: `${siteUrl}/`,
    links: [
      { rel: 'preload', as: 'image', type: 'image/avif', href: HeroImage_1024 },
    ],
    schemas,
  });
};

import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
