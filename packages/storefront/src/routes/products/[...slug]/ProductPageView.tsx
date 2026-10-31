import { shippingDateText } from '~/utils/shipping-label';
import { component$ } from '@qwik.dev/core';
import { OptimizedImage } from '~/components/ui/LazyImage';
import { Alert, CheckIcon, GuaranteeModalView, PaymentWidgetView, WaitlistView, hasView } from '~/platform/gateway';
import { sanitizeProductDescription } from '~/utils/sanitize';
import { availableForGroup, enhanceDescription, isVariantPurchasable, liveUnitPrice, optionPriceFor, priceDeltaLabel, swatchColor } from './product-options';
import { ProductImageModal } from './ProductImageModal';import { ProductMobileBar } from './ProductMobileBar';
import { ProductTrustBar } from './ProductTrustBar';
import { effectiveVariantPrice, type CatalogVariant } from '~/sellright/types/catalog';
import { LoyaltyPdpEarn } from '~/components/loyalty/LoyaltyPdpEarn';
import { ProductReviews } from '~/components/reviews/ProductReviews';
import { reviewsMeetThreshold, starString } from '~/utils/rewards';
import { productPageContent } from '~/platform/brand-data';
import { useRelatedProducts } from '~/platform/product-related';
import { formatPrice } from '~/utils/price-format';
import { PRICE_PLACEHOLDER } from '~/platform/live-values';

// A17 mount points. Each is undefined when the brand supplies no slot file; the markup that used to be inlined here
// now lives in the base's own default slot files under src/brand-slots.
const hasPaymentWidget = hasView('pdp.payment-widget');
const hasWaitlist = hasView('pdp.waitlist');
const hasGuaranteeModal = hasView('pdp.guarantee-modal');

export const ProductPageView = component$((props: Record<string, any>) => {
  const { pricesPending, relatedPrices, addItemToOrderErrorSignal, catalogInStock, enhancementError, isEnhancing, refreshLiveStock, allVariantsSoldOut, changeImage, closeImageModal, ctaClass, ctaDisabled, ctaTooltipFading, currentImageIndex, currentImageSig, displayPrice, galleryRef, groups, handleAddToCart, handleDotClick$, handleGalleryItemClick$, handleGalleryScroll, handleGroupSelect$, handleNamedVariantSelect$, handleThumbClick$, handleTouchEnd$, handleTouchMove$, handleTouchStart$, hasSale, isAddingToCart, isImageLoading, isOutOfStock, isPreOrder, liveStockReady, modalImageIndex, modalImageSrc, navigateModal, openImageModal, orderedAssets, preOrderConsent, product, productId, quantitySignal, rating, selectedValues, selectedVariant, selectedVariantIdSignal, showCtaTooltip, showFromPrefix, showImageModal } = props;
  // Price the payment-widget slot shows (same selection the inline widget used: pre-order price, else sale price, else display price).
  // ADR-0001 DP-1: while the shell's prices are pending nothing shows a price (placeholders hold their space).
  const pricePending = pricesPending?.value === true;
  let widgetPriceCents = 0;
  if (hasPaymentWidget && !pricePending) {
    const sv: CatalogVariant | undefined = selectedVariant.value;
    const sale = typeof sv?.salePrice === 'number' && sv.salePrice > 0 ? sv.salePrice : null;
    const pre = typeof sv?.preOrderPrice === 'number' && sv.preOrderPrice > 0 ? sv.preOrderPrice : null;
    widgetPriceCents = isPreOrder.value && pre ? pre : (!isPreOrder.value && sale ? sale : displayPrice.value);
  }
  // routes.json productPage: editorial content for this product and the related row (empty unless the brand turns it on).
  const content = productPageContent(String(product?.slug ?? ''));
  const related = useRelatedProducts();
  // the previous platform showed the waitlist whenever every variant was sold out (O/components/products/WaitlistForm.tsx use). Here "sold out" must
  // be real: a complete live read, or the manifest itself saying the product is out of stock (never an unchecked shell).
  const waitlistAvailable = hasWaitlist && allVariantsSoldOut.value && (liveStockReady.value || catalogInStock === false) && product.variants.some((v: CatalogVariant) => v.enabled !== false);
  const namedVariantPricesVary = !pricePending && groups.value.length === 0 && new Set(product.variants.map((v: CatalogVariant) => effectiveVariantPrice(v))).size > 1;
  return (
    <div class="sr-pdp">
      <div class="sr-layout">
        <div class="sr-left-col">
        <div class="sr-thumb-sidebar">
          {orderedAssets.value.map((asset: any, i: number) => (
            <button
              key={i}
              class={`sr-thumb-sidebar-btn${currentImageIndex.value === i ? ' active' : ''}`}
              data-idx={i}
              onClick$={handleThumbClick$}
              aria-label={`View image ${i + 1}`}
            >
              <OptimizedImage
                src={asset.preview.includes('asset_placeholder') ? '/asset_placeholder.webp' : asset.preview}
                alt={`${product.name} detail view`}
                loading="lazy"
                width={72} height={90}
                responsive="thumbnail"
              />
            </button>
          ))}
        </div>
        <div class="sr-gallery-wrap" ref={galleryRef} onScroll$={handleGalleryScroll}>
          {orderedAssets.value.map((asset: any, i: number) => (
            <div
              key={i}
              class="sr-gallery-item"
              data-idx={i}
              data-src={asset.preview.includes('asset_placeholder')
                ? asset.preview
                : asset.preview + '?preset=modal'}
              onClick$={handleGalleryItemClick$}
            >
              {i === 0 && allVariantsSoldOut.value && <div class="sr-badge sr-badge-soldout">Sold Out</div>}
              {i === 0 && isPreOrder.value && !allVariantsSoldOut.value && <div class="sr-badge sr-badge-preorder">Pre-order</div>}
              <OptimizedImage
                src={asset.preview}
                width={800} height={1000}
                loading={i === 0 ? 'eager' : 'lazy'}
                priority={i === 0}
                responsive="productMain"
                alt={`${product.name} — view ${i + 1}`}
              />
              {i === 0 && (
                <div class="sr-enlarge-hint">
                  <span class="sr-enlarge-label">Click to enlarge</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div
          class="sr-mobile-carousel"
          onTouchStart$={handleTouchStart$}
          onTouchMove$={handleTouchMove$}
          onTouchEnd$={handleTouchEnd$}
        >
          {allVariantsSoldOut.value && <div class="sr-badge sr-badge-soldout">Sold Out</div>}
          {isPreOrder.value && !allVariantsSoldOut.value && <div class="sr-badge sr-badge-preorder">Pre-order</div>}
          <div
            onClick$={() => {
              const src = currentImageSig.value.preview.includes('asset_placeholder')
                ? currentImageSig.value.preview
                : currentImageSig.value.preview + '?preset=modal';
              openImageModal(src, currentImageIndex.value);
            }}
            style={{ cursor: 'zoom-in' }}
          >
            <OptimizedImage
              src={currentImageSig.value.preview}
              alt={product.name}
              loading="eager" priority
              width={800} height={1000}
              responsive="productMain"
            />
          </div>
          {orderedAssets.value.length > 1 && (
            <>
              <button class="sr-carousel-btn sr-carousel-btn-prev"
                onClick$={() => { const l = orderedAssets.value.length; changeImage((currentImageIndex.value - 1 + l) % l); }}
                aria-label="Previous image">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
                </svg>
              </button>
              <button class="sr-carousel-btn sr-carousel-btn-next"
                onClick$={() => { const l = orderedAssets.value.length; changeImage((currentImageIndex.value + 1) % l); }}
                aria-label="Next image">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                </svg>
              </button>
              <div class="sr-carousel-dots">
                {orderedAssets.value.map((_: any, i: number) => (
                  <button key={i}
                    class={`sr-dot${currentImageIndex.value === i ? ' active' : ''}`}
                    data-idx={i}
                    onClick$={handleDotClick$}
                    aria-label={`Image ${i + 1}`} />
                ))}
              </div>
            </>
          )}
        </div>
        <div class="sr-mobile-dots">
          {orderedAssets.value.map((asset: any, index: number) => (
            <button key={asset.id}
              class={`sr-mobile-dot${currentImageIndex.value === index ? ' active' : ''}`}
              data-idx={index}
              onClick$={handleDotClick$}
              aria-label={`View image ${index + 1}`}
            />
          ))}
        </div>
        </div>{/* end sr-left-col */}
        <div class="sr-info-col">
          {isPreOrder.value && <div class="sr-kicker">New Release</div>}
          <h1 class="sr-title">{product.name}</h1>
          {rating && reviewsMeetThreshold(rating.count) && (
            <a
              href="#reviews"
              class="inline-flex items-center gap-2 -mt-3 mb-3 text-[13px] no-underline"
              style="color:var(--mid)"
              aria-label={`${rating.average.toFixed(1)} out of 5 stars, ${rating.count} ${rating.count === 1 ? 'review' : 'reviews'}`}
              data-testid="pdp-rating-link"
            >
              <span style="color:var(--gold);letter-spacing:2px;font-size:16px" aria-hidden="true">{starString(rating.average)}</span>
              <span>{rating.average.toFixed(1)} ({rating.count})</span>
            </a>
          )}
          {pricePending ? (
            <div class="sr-price-row" data-price-pending="">
              <span class="sr-price" aria-hidden="true" style={{ visibility: 'hidden' }}>{PRICE_PLACEHOLDER}</span>
            </div>
          ) : (() => {
            const sv: CatalogVariant | undefined = selectedVariant.value;
            const sale = typeof sv?.salePrice === 'number' && sv.salePrice > 0 ? sv.salePrice : null;
            const pre = typeof sv?.preOrderPrice === 'number' && sv.preOrderPrice > 0 ? sv.preOrderPrice : null;
            const regular = displayPrice.value;
            let live = regular;
            let strike: number | null = null;
            if (isPreOrder.value && pre) {
              live = pre;
              if (regular && regular !== pre) strike = regular;
            } else if (!isPreOrder.value && sale) {
              live = sale;
              if (regular && regular !== sale) strike = regular;
            }
            return (
              <div class="sr-price-row">
                {isPreOrder.value && <span class="sr-price-badge">PRE-ORDER</span>}
                {hasSale.value && !isPreOrder.value && <span class="sr-price-badge">SALE</span>}
                {showFromPrefix.value && !hasSale.value && !isPreOrder.value && (
                  <span class="sr-price-from">From</span>
                )}
                {strike !== null && (
                  <span class="sr-price-original">{`$${(strike / 100).toFixed(0)}`}</span>
                )}
                <span class="sr-price">{`$${(live / 100).toFixed(0)}`}</span>
              </div>
            );
          })()}
          <LoyaltyPdpEarn
            cents={liveUnitPrice(selectedVariant.value, !!isPreOrder.value, displayPrice.value)}
            productId={productId}
            from={!!showFromPrefix.value && !hasSale.value && !isPreOrder.value}
          />
          {hasPaymentWidget && (pricePending ? (
            <div aria-hidden="true" style={{ visibility: 'hidden' }}><PaymentWidgetView priceCents={0} /></div>
          ) : <PaymentWidgetView priceCents={widgetPriceCents} />)}
          <div class="sr-rule" />
          {enhancementError.value && (
            <div role="status" class="sr-stock-error" style="margin:0 0 12px">
              <p>Unable to check availability.</p>
              <button type="button" class="sr-stock-retry" style="text-decoration:underline;cursor:pointer;background:none;border:0;padding:0;font:inherit;color:inherit" disabled={isEnhancing.value}
                onClick$={() => refreshLiveStock()}>Retry availability</button>
            </div>
          )}
          {groups.value.length === 0 && product.variants.length > 1 && (
            <div class="sr-sel-group">
              <div class="sr-sel-head">
                <span class="sr-sel-label">01 — Variant</span>
                {selectedVariant.value && <span class="sr-sel-chosen">{selectedVariant.value.name}</span>}
              </div>
              <div class="sr-pill-grid">
                {product.variants.map((variant: CatalogVariant) => {
                  const available = isVariantPurchasable(variant);
                  const chosen = selectedValues.value[0] === variant.sku;
                  return (
                    <button key={variant.sku}
                      class={`sr-pill${chosen ? ' active' : ''}${!available ? ' oos' : ''}`}
                      disabled={!available}
                      aria-pressed={chosen}
                      data-variant-sku={variant.sku}
                      onClick$={handleNamedVariantSelect$}
                    >
                      <span>{variant.name}</span>
                      {namedVariantPricesVary && <span class="sr-pill-price">{formatPrice(effectiveVariantPrice(variant), product.currency || undefined)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {groups.value.map((group: { groupName: string; values: string[] }, groupIdx: number) => {
            const isMulti = groups.value.length > 1;
            // #408: every group is open from the start and can be chosen in any order. A value no purchasable variant has is
            // disabled; one that only fails with the current choices stays clickable, marked unavailable (choosing it swaps).
            const purchasable = availableForGroup(product.variants, groups.value, groupIdx, []);
            const available = availableForGroup(product.variants, groups.value, groupIdx, selectedValues.value);
            const chosenVal = selectedValues.value[groupIdx];
            const isBladeGroup = isMulti && groupIdx === 0;
            const isColorGroup = /color|colour|handle/i.test(group.groupName);
            const isHandleGroup = isMulti && groupIdx > 0 && isColorGroup;
            const isColorSingle = !isMulti && isColorGroup;
            return (
              <div key={group.groupName} style={groupIdx > 0 ? { paddingTop: '28px' } : {}}>
                <div class="sr-sel-group">
                  <div class="sr-sel-head">
                    <span class="sr-sel-label">0{groupIdx + 1} — {group.groupName}</span>
                    {chosenVal && <span class="sr-sel-chosen">{chosenVal}</span>}
                  </div>
                  {isBladeGroup && (
                    <div class="sr-blade-grid" style={`grid-template-columns: repeat(${group.values.length}, 1fr)`}>
                      {group.values.map((val: string) => {
                        const isAvail = available.has(val);
                        const delta = priceDeltaLabel(product.variants, groups.value, val);
                        return (
                          <button key={val}
                            class={`sr-blade-card${chosenVal === val ? ' active' : ''}${!isAvail ? ' oos' : ''}`}
                            disabled={!purchasable.has(val)}
                            aria-label={!purchasable.has(val) ? `${val}, sold out` : !isAvail ? `${val}, unavailable with your other choice` : undefined}
                            data-group-name={group.groupName}
                            data-val={val}
                            onClick$={handleGroupSelect$}
                          >
                            <div class="sr-blade-name">{val}</div>
                            {delta && <div class={`sr-blade-delta${delta.startsWith('+') ? ' plus' : ''}`}>{delta}</div>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(isHandleGroup || isColorSingle) && (
                    <div class="sr-swatch-grid">
                      {group.values.map((val: string) => {
                        const isAvail = available.has(val);
                        const color = swatchColor(val);
                        return (
                          <button key={val}
                            class={`sr-swatch-btn${chosenVal === val ? ' active' : ''}${!isAvail ? ' oos' : ''}`}
                            disabled={!purchasable.has(val)}
                            aria-label={!purchasable.has(val) ? `${val}, sold out` : !isAvail ? `${val}, unavailable with your other choice` : undefined}
                            data-group-name={group.groupName}
                            data-val={val}
                            onClick$={handleGroupSelect$}
                          >
                            <div
                              class="sr-swatch"
                              style={{
                                background: color,
                                borderColor: `${color}bb`,
                                outline: chosenVal === val ? '2px solid var(--color-accent)' : 'none',
                                outlineOffset: chosenVal === val ? '3px' : '0',
                              }}
                            />
                            <span class="sr-swatch-name">{val}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!isBladeGroup && !isHandleGroup && !isColorSingle && (() => {
                    const prices = product.variants.map((v: CatalogVariant) => effectiveVariantPrice(v));
                    const pricesVary = new Set(prices).size > 1;
                    return (
                    <div class="sr-pill-grid">
                      {group.values.map((val: string) => {
                        const isAvail = available.has(val);
                        const optionPrice = pricesVary ? optionPriceFor(product.variants, groups.value, groupIdx, val, selectedValues.value) : null;
                        const pillPrice = optionPrice !== null ? `$${(optionPrice / 100).toFixed(0)}` : null;
                        return (
                          <button key={val}
                            class={`sr-pill${chosenVal === val ? ' active' : ''}${!isAvail ? ' oos' : ''}`}
                            disabled={!purchasable.has(val)}
                            aria-label={!purchasable.has(val) ? `${val}, sold out` : !isAvail ? `${val}, unavailable with your other choice` : undefined}
                            data-group-name={group.groupName}
                            data-val={val}
                            onClick$={handleGroupSelect$}
                          >
                            <span>{val}</span>
                            {pillPrice && <span class="sr-pill-price">{pillPrice}</span>}
                          </button>
                        );
                      })}
                    </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
          <div class="sr-rule" />
          {isPreOrder.value && selectedVariant.value && (
            <div class="sr-consent">
              <input type="checkbox"
                checked={preOrderConsent.value}
                onChange$={() => (preOrderConsent.value = !preOrderConsent.value)}
                id="po-consent"
              />
              <label for="po-consent" class="sr-consent-text" style="cursor:pointer">
                I understand this product will ship around{' '}
                {shippingDateText(selectedVariant.value) || 'the estimated date'}.
              </label>
            </div>
          )}
          <div class="sr-cta-desktop">
            {allVariantsSoldOut.value ? (
              <button class="sr-cta-btn oos">Out of Stock</button>
            ) : (
              <div class="sr-cta-wrap">
              {showCtaTooltip.value && (
                <div class={`sr-cta-tooltip${ctaTooltipFading.value ? ' fade-out' : ''}`}>
                  Please complete your selection above
                </div>
              )}
              <button
                class={ctaClass.value}
                title=""
                disabled={isAddingToCart.value || isOutOfStock.value}
                onClick$={() => {
                  if (isOutOfStock.value) return;
                  if (ctaDisabled.value) {
                    showCtaTooltip.value = true;
                    ctaTooltipFading.value = false;
                    setTimeout(() => { ctaTooltipFading.value = true; }, 1700);
                    setTimeout(() => { showCtaTooltip.value = false; ctaTooltipFading.value = false; }, 2000);
                    return;
                  }
                  handleAddToCart();
                }}
              >
                {isAddingToCart.value ? (
                  <>
                    <span style="display:inline-flex;width:14px;height:14px;animation:sr-spin 0.7s linear infinite"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg></span>
                    Adding…
                  </>
                ) : (selectedVariantIdSignal.value && quantitySignal.value[selectedVariantIdSignal.value] > 0) ? (
                  <>
                    <CheckIcon />
                    {quantitySignal.value[selectedVariantIdSignal.value!]} in cart · Add more
                    <div class="sr-cta-arrow" />
                  </>
                ) : ctaDisabled.value ? (
                  'Select options'
                ) : isOutOfStock.value ? (
                  'Out of Stock'
                ) : isPreOrder.value ? (
                  <>Pre-order now <div class="sr-cta-arrow" /></>
                ) : (
                  <>Add to cart <div class="sr-cta-arrow" /></>
                )}
              </button>
              {isPreOrder.value && selectedVariant.value && (
                <div class="sr-ship-note">
                  Ships {shippingDateText(selectedVariant.value) || 'when ready'}
                </div>
              )}
              </div>
            )}
            {!!addItemToOrderErrorSignal.value && (
              <div style="margin-top:8px">
                <Alert message={String(addItemToOrderErrorSignal.value)} />
              </div>
            )}
          </div>
          {waitlistAvailable && (
            <div id="sr-pdp-waitlist">
              <WaitlistView productId={productId ?? ''} productName={product.name || ''} soldOut={true} />
            </div>
          )}
          <ProductTrustBar />
          {hasGuaranteeModal && <GuaranteeModalView productId={productId} productName={product.name || ''} />}
          <div class="sr-rule" />
          {product.description && (
            <div
              class="sr-desc"
              dangerouslySetInnerHTML={enhanceDescription(product.name, sanitizeProductDescription(product.description || ''))}
            />
          )}
          {content?.designNote && (
            <div class="sr-designnote">
              <div class="sr-designnote-title">Design notes</div>
              <p class="sr-designnote-text">{content.designNote}</p>
            </div>
          )}
          {content?.faqs && content.faqs.length > 0 && (
            <div class="sr-faq">
              <div class="sr-faq-title">Common questions</div>
              {content.faqs.map((f, i) => (
                <details key={i} class="sr-faq-item">
                  <summary class="sr-faq-q">{f.q}</summary>
                  <p class="sr-faq-a">{f.a}</p>
                </details>
              ))}
            </div>
          )}
          {isPreOrder.value && (
            <div class="sr-po-notice">
              <div class="sr-po-dot" />
              <div class="sr-po-text">
                <strong>Pre-order open.</strong> Production is underway.{' '}
                {shippingDateText(selectedVariant.value)
                  ? `Estimated ship: ${shippingDateText(selectedVariant.value)}.`
                  : 'Your card will be charged at the time of purchase.'}
              </div>
            </div>
          )}
        </div>{/* end sr-info-col */}
      </div>{/* end sr-layout */}
      {related.value.items.length > 0 && (
        <section class="sr-related">
          <h2 class="sr-related-title">{related.value.heading}</h2>
          <div class="sr-related-grid">
            {/* A plain <a> (full load), as the base product links: the PDP state does not re-sync on an SPA product change. */}
            {related.value.items.map((rp) => (
              <a key={rp.slug} href={rp.href} class="sr-related-card">
                <div class="sr-related-img">
                  {rp.image && <OptimizedImage src={rp.image} width={300} height={375} alt={rp.name} class="sr-related-photo" />}
                </div>
                <div class="sr-related-name">{rp.name}</div>
                {(() => {
                  // ADR-0001 DP-1: a shell row's prices come from the page's live read (relatedPrices); until then a placeholder.
                  const cents = rp.pricePending ? relatedPrices?.value?.[rp.slug] ?? null : rp.priceCents;
                  return <div class="sr-related-price">{cents === null ? <span aria-hidden="true" style={{ visibility: 'hidden' }}>{PRICE_PLACEHOLDER}</span> : cents > 0 ? formatPrice(cents, product.currency || undefined) : ''}</div>;
                })()}
              </a>
            ))}
          </div>
        </section>
      )}
      {product?.slug && <ProductReviews slug={product.slug} productName={product.name || 'this product'} />}
      <ProductMobileBar
        allVariantsSoldOut={allVariantsSoldOut}
        ctaClass={ctaClass}
        ctaDisabled={ctaDisabled}
        ctaTooltipFading={ctaTooltipFading}
        displayPrice={displayPrice}
        pricesPending={pricesPending}
        handleAddToCart={handleAddToCart}
        isAddingToCart={isAddingToCart}
        isOutOfStock={isOutOfStock}
        isPreOrder={isPreOrder}
        product={product}
        selectedVariant={selectedVariant}
        showCtaTooltip={showCtaTooltip}
        showFromPrefix={showFromPrefix}
        waitlistAvailable={waitlistAvailable}
      />
      {showImageModal.value && (
        <ProductImageModal
          closeImageModal={closeImageModal}
          isImageLoading={isImageLoading}
          modalImageIndex={modalImageIndex}
          modalImageSrc={modalImageSrc}
          navigateModal={navigateModal}
          orderedAssets={orderedAssets}
          product={product}
        />
      )}
    </div>
  );
});