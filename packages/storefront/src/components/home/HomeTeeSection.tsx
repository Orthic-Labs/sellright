import { component$ } from '@qwik.dev/core';
import { stripHtml } from '~/utils/sanitize';
// Tee section image — 65: decorative/lifestyle section, not a purchase decision image
import TeeImage_480 from '~/media/homelast.png?format=avif&w=480&quality=65&url';
import TeeImage_768 from '~/media/homelast.png?format=avif&w=768&quality=65&url';
import TeeImage_1024 from '~/media/homelast.png?format=avif&w=1024&quality=65&url';
import TeeImageWebP_480 from '~/media/homelast.png?format=webp&w=480&quality=70&url';
import TeeImageWebP_768 from '~/media/homelast.png?format=webp&w=768&quality=70&url';
import TeeImageWebP_1024 from '~/media/homelast.png?format=webp&w=1024&quality=70&url';
import TeeImageJPEG_1024 from '~/media/homelast.png?format=jpeg&w=1024&quality=80&url';
import Price from '~/components/products/Price';

interface FeaturedProduct {
  name: string;
  slug: string;
  category?: string | null;
  description?: string | null;
  featuredAsset?: { preview?: string } | null;
}
interface FeaturedVariant {
  price?: number;
  priceWithTax?: number;
  customFields?: { salePrice?: number | null; preOrderPrice?: number | null; isPreOrder?: boolean };
}

interface HomeTeeSectionProps {
  /** The same real catalog product/variant the hero spotlight section uses
   * (routes/index.tsx usePreorderProduct, gated on VITE_HOME_SPOTLIGHT_SLUG).
   * Never fabricate material/fit/finish claims here — when unset, this
   * section shows only generic, truthful copy and links to /shop. */
  product?: FeaturedProduct | null;
  variant?: FeaturedVariant | null;
}

export const HomeTeeSection = component$<HomeTeeSectionProps>(({ product, variant }) => {
  const body = product?.description ? stripHtml(product.description).trim() : 'Thoughtfully made. Built to last. Every item in the shop gets the same attention to detail.';
  const href = product ? `/products/${product.slug}` : '/shop';
  return (
  <>
      {/* ════════ Featured product section ════════ */}
      <section class="tee">
            <div class="tee-img-wrap">
              <span class="tee-tag">New Arrival</span>
              <picture>
                {product?.featuredAsset?.preview ? (
                  <img src={`${product.featuredAsset.preview}?preset=large`} alt={product.name}
                    loading="lazy" decoding="async" width={1024} height={1024} class="tee-img" />
                ) : (
                  <>
                    <source type="image/avif" srcset={`${TeeImage_480} 480w, ${TeeImage_768} 768w, ${TeeImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                    <source type="image/webp" srcset={`${TeeImageWebP_480} 480w, ${TeeImageWebP_768} 768w, ${TeeImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                    <img src={TeeImageJPEG_1024} alt="Featured product"
                      loading="lazy" decoding="async" width={1024} height={1024} class="tee-img" />
                  </>
                )}
              </picture>
            </div>
            <div>
              <div class="tee-label" data-reveal>Featured</div>
              <h2 class="tee-title" data-reveal>{product ? product.name : 'New arrivals.'}</h2>
              {product && variant && (
                <div class="tee-price-wrap">
                  <Price
                    priceWithTax={variant.priceWithTax ?? variant.price}
                    salePrice={variant.customFields?.salePrice}
                    preOrderPrice={variant.customFields?.preOrderPrice}
                    isPreOrder={variant.customFields?.isPreOrder}
                    forcedClass="tee-price"
                  />
                </div>
              )}
              <p class="tee-body" data-reveal>{body}</p>
              {product?.category && (
                <div>
                  <div class="tee-spec">
                    <span class="tee-spec-k">Category</span>
                    <span class="tee-spec-v">{product.category.replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                  </div>
                </div>
              )}
              <a href={href} class="btn-primary">Shop Now <span class="btn-arrow">&rarr;</span></a>
            </div>
      </section>
  </>
  );
});
