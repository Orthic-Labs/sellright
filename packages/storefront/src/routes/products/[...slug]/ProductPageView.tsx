import { component$ } from '@qwik.dev/core';
import { OptimizedImage } from '~/components/ui';
import Alert from '~/components/alert/Alert';
import CheckIcon from '~/components/icons/CheckIcon';
import type { Variant } from '~/types';
import { sanitizeProductDescription } from '~/utils/sanitize';
import { availableForGroup, enhanceDescription, priceDeltaLabel, swatchColor, titleCase } from './product-options';
import { ProductImageModal } from './ProductImageModal';
import { ProductMobileBar } from './ProductMobileBar';
import { ProductTrustBar } from './ProductTrustBar';

type ProductOptionGroup = { groupName: string; values: string[] };

export const ProductPageView = component$((props: Record<string, any>) => {
  const {
    addItemToOrderErrorSignal,
    allVariantsSoldOut,
    changeImage,
    closeImageModal,
    ctaClass,
    ctaDisabled,
    ctaTooltipFading,
    currentImageIndex,
    currentImageSig,
    displayPrice,
    galleryRef,
    groups,
    handleAddToCart,
    handleDotClick$,
    handleGalleryItemClick$,
    handleGalleryScroll,
    handleGroupSelect$,
    handleThumbClick$,
    handleTouchEnd$,
    handleTouchMove$,
    handleTouchStart$,
    hasSale,
    isAddingToCart,
    isImageLoading,
    isOutOfStock,
    isPreOrder,
    modalImageIndex,
    modalImageSrc,
    navigateModal,
    openImageModal,
    orderedAssets,
    preOrderConsent,
    product,
    quantitySignal,
    selectedValues,
    selectedVariant,
    selectedVariantIdSignal,
    showCtaTooltip,
    showFromPrefix,
    showImageModal,
  } = props;
  return (
    <div class="dd-pdp">
      <div class="dd-layout">
        <div class="dd-left-col">
        <div class="dd-thumb-sidebar">
          {orderedAssets.value.map((asset: any, i: number) => (
            <button
              key={i}
              class={`dd-thumb-sidebar-btn${currentImageIndex.value === i ? ' active' : ''}`}
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
        <div class="dd-gallery-wrap" ref={galleryRef} onScroll$={handleGalleryScroll}>
          {orderedAssets.value.map((asset: any, i: number) => (
            <div
              key={i}
              class="dd-gallery-item"
              data-idx={i}
              data-src={asset.preview.includes('asset_placeholder')
                ? asset.preview
                : asset.preview + '?preset=modal'}
              onClick$={handleGalleryItemClick$}
            >
              {i === 0 && allVariantsSoldOut.value && <div class="dd-badge dd-badge-soldout">Sold Out</div>}
              {i === 0 && isPreOrder.value && !allVariantsSoldOut.value && <div class="dd-badge dd-badge-preorder">Pre-order</div>}
              <OptimizedImage
                src={asset.preview}
                width={800} height={1000}
                loading={i === 0 ? 'eager' : 'lazy'}
                priority={i === 0}
                responsive="productMain"
                alt={`${product.name} — view ${i + 1}`}
              />
              {i === 0 && (
                <div class="dd-enlarge-hint">
                  <span class="dd-enlarge-label">Click to enlarge</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div
          class="dd-mobile-carousel"
          onTouchStart$={handleTouchStart$}
          onTouchMove$={handleTouchMove$}
          onTouchEnd$={handleTouchEnd$}
        >
          {allVariantsSoldOut.value && <div class="dd-badge dd-badge-soldout">Sold Out</div>}
          {isPreOrder.value && !allVariantsSoldOut.value && <div class="dd-badge dd-badge-preorder">Pre-order</div>}
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
              alt={`${product.name} — Damned Designs`}
              loading="eager" priority
              width={800} height={1000}
              responsive="productMain"
            />
          </div>
          {orderedAssets.value.length > 1 && (
            <>
              <button class="dd-carousel-btn dd-carousel-btn-prev"
                onClick$={() => { const l = orderedAssets.value.length; changeImage((currentImageIndex.value - 1 + l) % l); }}
                aria-label="Previous image">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
                </svg>
              </button>
              <button class="dd-carousel-btn dd-carousel-btn-next"
                onClick$={() => { const l = orderedAssets.value.length; changeImage((currentImageIndex.value + 1) % l); }}
                aria-label="Next image">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                </svg>
              </button>
              <div class="dd-carousel-dots">
                {orderedAssets.value.map((_: any, i: number) => (
                  <button key={i}
                    class={`dd-dot${currentImageIndex.value === i ? ' active' : ''}`}
                    data-idx={i}
                    onClick$={handleDotClick$}
                    aria-label={`Image ${i + 1}`} />
                ))}
              </div>
            </>
          )}
        </div>
        <div class="dd-mobile-dots">
          {orderedAssets.value.map((asset: any, index: number) => (
            <button key={asset.id}
              class={`dd-mobile-dot${currentImageIndex.value === index ? ' active' : ''}`}
              data-idx={index}
              onClick$={handleDotClick$}
              aria-label={`View image ${index + 1}`}
            />
          ))}
        </div>
        </div>{/* end dd-left-col */}
        <div class="dd-info-col">
          {isPreOrder.value && <div class="dd-kicker">New Release</div>}
          <h1 class="dd-title">{titleCase(product.name)}</h1>
          {(() => {
            const sv: any = selectedVariant.value;
            const cf = sv?.customFields;
            const sale = typeof cf?.salePrice === 'number' && cf.salePrice > 0 ? cf.salePrice : null;
            const pre = typeof cf?.preOrderPrice === 'number' && cf.preOrderPrice > 0 ? cf.preOrderPrice : null;
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
              <div class="dd-price-row">
                {isPreOrder.value && <span class="dd-price-badge">PRE-ORDER</span>}
                {hasSale.value && !isPreOrder.value && <span class="dd-price-badge">SALE</span>}
                {showFromPrefix.value && !hasSale.value && !isPreOrder.value && (
                  <span class="dd-price-from">From</span>
                )}
                {strike !== null && (
                  <span class="dd-price-original">{`$${(strike / 100).toFixed(0)}`}</span>
                )}
                <span class="dd-price">{`$${(live / 100).toFixed(0)}`}</span>
              </div>
            );
          })()}
          {(() => {
            const sv: any = selectedVariant.value;
            const cf = sv?.customFields;
            const sale = typeof cf?.salePrice === 'number' && cf.salePrice > 0 ? cf.salePrice : null;
            const pre = typeof cf?.preOrderPrice === 'number' && cf.preOrderPrice > 0 ? cf.preOrderPrice : null;
            const live = isPreOrder.value && pre ? pre : (!isPreOrder.value && sale ? sale : displayPrice.value);
            return (
              <div class="dd-sezzle-inline">
                or 4 interest-free payments of <strong>${(live / 400).toFixed(0)}</strong> with{' '}
                <a href="https://sezzle.com/how-it-works" target="_blank" rel="noopener noreferrer">
                  <img src="/sezzle-color.svg" alt="Sezzle" width="58" height="16" loading="lazy" style={{ display: 'inline', verticalAlign: 'middle', marginLeft: '3px' }} />
                </a>
              </div>
            );
          })()}
          <div class="dd-rule" />
          {groups.value.map((group: ProductOptionGroup, groupIdx: number) => {
            const isMulti = groups.value.length > 1;
            const isLocked = groupIdx > 0 && !selectedValues.value[groupIdx - 1];
            const available = isLocked
              ? new Set<string>()
              : availableForGroup(product.variants, groups.value, groupIdx, selectedValues.value);
            const chosenVal = selectedValues.value[groupIdx];
            const isBladeGroup = isMulti && groupIdx === 0;
            const isColorGroup = /color|colour|handle/i.test(group.groupName);
            const isHandleGroup = isMulti && groupIdx > 0 && isColorGroup;
            const isColorSingle = !isMulti && isColorGroup;
            return (
              <div key={group.groupName} style={groupIdx > 0 ? { paddingTop: '28px' } : {}}>
                <div class={`dd-sel-group${isLocked ? ' locked' : ''}`}
                  style={isMulti && groupIdx > 0 && isLocked ? { display: 'none' } : isMulti && groupIdx > 0 ? { animation: 'dd-fadeIn 0.2s ease' } : {}}
                >
                  <div class="dd-sel-head">
                    <span class="dd-sel-label">0{groupIdx + 1} — {group.groupName}</span>
                    {chosenVal && <span class="dd-sel-chosen">{chosenVal}</span>}
                  </div>
                  {isBladeGroup && (
                    <div class="dd-blade-grid" style={`grid-template-columns: repeat(${group.values.length}, 1fr)`}>
                      {group.values.map((val: string) => {
                        const isAvail = available.has(val);
                        const delta = priceDeltaLabel(product.variants, groups.value, val);
                        return (
                          <button key={val}
                            class={`dd-blade-card${chosenVal === val ? ' active' : ''}${!isAvail ? ' oos' : ''}`}
                            disabled={!isAvail}
                            data-group-name={group.groupName}
                            data-val={val}
                            data-reset="1"
                            onClick$={handleGroupSelect$}
                          >
                            <div class="dd-blade-name">{val}</div>
                            {delta && <div class={`dd-blade-delta${delta.startsWith('+') ? ' plus' : ''}`}>{delta}</div>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(isHandleGroup || isColorSingle) && (
                    <div class="dd-swatch-grid">
                      {group.values.map((val: string) => {
                        const isAvail = available.has(val);
                        const color = swatchColor(val);
                        return (
                          <button key={val}
                            class={`dd-swatch-btn${chosenVal === val ? ' active' : ''}${!isAvail ? ' oos' : ''}`}
                            disabled={!isAvail}
                            data-group-name={group.groupName}
                            data-val={val}
                            onClick$={handleGroupSelect$}
                          >
                            <div
                              class="dd-swatch"
                              style={{
                                background: color,
                                borderColor: `${color}bb`,
                                outline: chosenVal === val ? '2px solid #965341' : 'none',
                                outlineOffset: chosenVal === val ? '3px' : '0',
                              }}
                            />
                            <span class="dd-swatch-name">{val}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!isBladeGroup && !isHandleGroup && !isColorSingle && (() => {
                    const prices = product.variants.map((v: Variant) => v.priceWithTax || v.price || 0);
                    const pricesVary = new Set(prices).size > 1;
                    return (
                    <div class="dd-pill-grid">
                      {group.values.map((val: string) => {
                        const isAvail = available.has(val);
                        const matchingVariant = product.variants.find((v: Variant) =>
                          v.options?.some(o => o.name === val)
                        );
                        const pillPrice = pricesVary && matchingVariant
                          ? `$${((matchingVariant.priceWithTax || matchingVariant.price || 0) / 100).toFixed(0)}`
                          : null;
                        return (
                          <button key={val}
                            class={`dd-pill${chosenVal === val ? ' active' : ''}${!isAvail ? ' oos' : ''}`}
                            disabled={!isAvail}
                            data-group-name={group.groupName}
                            data-val={val}
                            onClick$={handleGroupSelect$}
                          >
                            <span>{val}</span>
                            {pillPrice && <span class="dd-pill-price">{pillPrice}</span>}
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
          <div class="dd-rule" />
          {isPreOrder.value && selectedVariant.value && (
            <div class="dd-consent">
              <input type="checkbox"
                checked={preOrderConsent.value}
                onChange$={() => (preOrderConsent.value = !preOrderConsent.value)}
                id="po-consent"
              />
              <label for="po-consent" class="dd-consent-text" style="cursor:pointer">
                I understand this product will ship around{' '}
                {selectedVariant.value?.customFields?.shipDate || 'the estimated date'}.
              </label>
            </div>
          )}
          <div class="dd-cta-desktop">
            {allVariantsSoldOut.value ? (
              <button class="dd-cta-btn oos">Out of Stock</button>
            ) : (
              <div class="dd-cta-wrap">
              {showCtaTooltip.value && (
                <div class={`dd-cta-tooltip${ctaTooltipFading.value ? ' fade-out' : ''}`}>
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
                    <span style="display:inline-flex;width:14px;height:14px;animation:dd-spin 0.7s linear infinite"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg></span>
                    Adding…
                  </>
                ) : (selectedVariantIdSignal.value && quantitySignal.value[selectedVariantIdSignal.value] > 0) ? (
                  <>
                    <CheckIcon />
                    {quantitySignal.value[selectedVariantIdSignal.value!]} in cart · Add more
                    <div class="dd-cta-arrow" />
                  </>
                ) : ctaDisabled.value ? (
                  'Select options'
                ) : isOutOfStock.value ? (
                  'Out of Stock'
                ) : isPreOrder.value ? (
                  <>Pre-order now <div class="dd-cta-arrow" /></>
                ) : (
                  <>Add to cart <div class="dd-cta-arrow" /></>
                )}
              </button>
              {isPreOrder.value && selectedVariant.value && (
                <div class="dd-ship-note">
                  Ships {selectedVariant.value?.customFields?.shipDate || 'when ready'}
                </div>
              )}
              </div>
            )}
            {!!addItemToOrderErrorSignal.value && (
              <div style="margin-top:8px">
                <Alert message={addItemToOrderErrorSignal.value} />
              </div>
            )}
          </div>
          <ProductTrustBar />
          <div class="dd-rule" />
          {product.description && (
            <div
              class="dd-desc"
              dangerouslySetInnerHTML={enhanceDescription(product.name, sanitizeProductDescription(product.description || ''))}
            />
          )}
          {isPreOrder.value && (
            <div class="dd-po-notice">
              <div class="dd-po-dot" />
              <div class="dd-po-text">
                <strong>Pre-order open.</strong> Production is underway.{' '}
                {selectedVariant.value?.customFields?.shipDate
                  ? `Estimated ship: ${selectedVariant.value.customFields.shipDate}.`
                  : 'Your card will be charged at the time of purchase.'}
              </div>
            </div>
          )}
        </div>{/* end dd-info-col */}
      </div>{/* end dd-layout */}
      <ProductMobileBar
        allVariantsSoldOut={allVariantsSoldOut}
        ctaClass={ctaClass}
        ctaDisabled={ctaDisabled}
        ctaTooltipFading={ctaTooltipFading}
        displayPrice={displayPrice}
        handleAddToCart={handleAddToCart}
        isAddingToCart={isAddingToCart}
        isOutOfStock={isOutOfStock}
        isPreOrder={isPreOrder}
        product={product}
        selectedVariant={selectedVariant}
        showCtaTooltip={showCtaTooltip}
        showFromPrefix={showFromPrefix}
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