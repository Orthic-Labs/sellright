// Homepage - Refined editorial design
import { component$, useStyles$, useSignal, useContext, $ } from '@qwik.dev/core';
import type { JsonLdSchema } from '~/types/seo.types';
import { useOrganizationJsonLd, usePreorderProduct, useFeatureProduct, useFeaturedProducts, useHomeCollections, buildHomeHead } from '~/platform/home';
import { APP_STATE } from '~/constants';
import type { CartLineEnrichment } from '~/sellright/types/cart';
import { useCart, addToCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { TURNSTILE_SITE_KEY } from '~/utils/turnstile-widget';
import { stripHtml } from '~/utils/sanitize';
import { homepageStyles, hasView, HomeHero, HomeTeeSection, HomeServiceSection, HomeTrustBar, Price, ProductCard } from '~/platform/gateway';
import { useStoreIdentityLoader } from '~/routes/layout';
import { BrandHomeMount, useNewsletterForm } from '~/platform/controllers/content';
import { projectHeroPolicies, projectPolicies, projectFeatureProduct, projectFeatureVariant, projectPrice, projectProductTiles } from '~/platform/controllers/project';
import HeroImage_1024 from '~/media/hero.jpg?format=avif&w=1024&quality=75&url';

// Spotlight section image — 65: decorative/lifestyle, not a purchase decision image
import PreorderImage_480 from '~/media/sec2.jpg?format=avif&w=480&quality=65&url';
import PreorderImage_768 from '~/media/sec2.jpg?format=avif&w=768&quality=65&url';
import PreorderImage_1024 from '~/media/sec2.jpg?format=avif&w=1024&quality=65&url';
import PreorderImageWebP_480 from '~/media/sec2.jpg?format=webp&w=480&quality=70&url';
import PreorderImageWebP_768 from '~/media/sec2.jpg?format=webp&w=768&quality=70&url';
import PreorderImageWebP_1024 from '~/media/sec2.jpg?format=webp&w=1024&quality=70&url';
import PreorderImageJPEG_1024 from '~/media/sec2.jpg?format=jpeg&w=1024&quality=80&url';

export { useOrganizationJsonLd, usePreorderProduct, useFeatureProduct, useFeaturedProducts, useHomeCollections };

const BaseHomePage = component$(() => {
  useStyles$(homepageStyles);

  const appState = useContext(APP_STATE);
  const cart = useCart();
  const identity = useStoreIdentityLoader();
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

  // The newsletter state, its Turnstile widget and its submit live in the platform (platform/controllers/content.tsx).
  const { email: nlEmail, honeypot: nlHoneypot, state: nlState, error: nlError, token: nlToken, handleSubmit: handleNewsletterSubmit } = useNewsletterForm();

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

      const enrichment: CartLineEnrichment = {
        slug: product.slug,
        image: variant.featuredAsset?.preview ?? product.featuredAsset?.preview ?? null,
        name: variant.name,
        options: (variant.options || []).map((o: any) => o.name).join(' / '),
        isPreOrder: true,
        shipDate: variant.customFields?.shipDate,
      };

      // Cart add via the single server-owned CartContext — dispatches the
      // header-badge update itself (see CartContext.tsx addToCart).
      await addToCart(cart, variant.id, 1, enrichment);
      cart.hasLoadedOnce = true;
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
      <HomeHero storeName={identity.value.identity.storeName} tagline={identity.value.identity.tagline} policies={projectHeroPolicies(identity.value.identity.policies)} />

      <HomeTrustBar policies={projectPolicies(identity.value.identity.policies)} />

      {/* ════════ Spotlight section (only renders when a real product is configured) ════════ */}
      {preorderProduct.value && (
        <section class="preorder">
              <div>
                <div class="po-badge reveal visible"><span class="po-dot-green" />Featured</div>
                <h2 class="po-title reveal visible" data-reveal>{preorderProduct.value.name}</h2>
                {spotlightVariant && (
                  <div class="po-price-wrap">
                    <Price {...projectPrice(spotlightVariant)} forcedClass="po-price" />
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
                  <a href={productPath(preorderProduct.value.slug)} class="btn-ghost--dark">View Details</a>
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

      <HomeTeeSection product={projectFeatureProduct(featureProduct.value)} variant={projectFeatureVariant(featureVariant)} href={featureProduct.value ? productPath(featureProduct.value.slug) : undefined} />

      {/* ════════ Shop the collection — live catalog grid ════════ */}
      {featuredProducts.value.length > 0 && (
        <section class="featured-grid">
          <div class="featured-grid-head" data-reveal>
            <div class="tee-label">Shop the collection</div>
            <h2 class="featured-grid-title">Everything, considered.</h2>
          </div>
          <div class="featured-grid-items">
            {projectProductTiles(featuredProducts.value).map((tile, i) => (
              <ProductCard
                key={tile.slug}
                href={productPath(tile.slug)}
                name={tile.name}
                image={tile.image}
                slug={tile.slug}
                price={tile.price}
                inStock={tile.inStock}
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
              <div id="nl-turnstile" class="min-h-[65px] w-full"></div>
              <button
                type="submit"
                class="nl-submit"
                disabled={nlState.value === 'sending' || (!!TURNSTILE_SITE_KEY && !nlToken.value)}
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

export default hasView('route.home') ? BrandHomeMount : BaseHomePage;

export const head = ({ resolveValue }: { resolveValue: any }) => {
  const schemas = resolveValue(useOrganizationJsonLd) as unknown as JsonLdSchema[];
  const identity = resolveValue(useStoreIdentityLoader);
  return buildHomeHead(schemas, identity, HeroImage_1024);
};

import type { StaticGenerateHandler } from '@qwik.dev/router';
import { productPath } from '~/platform/product-path';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
