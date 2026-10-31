import { $, component$, useOnWindow, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { PRICE_PLACEHOLDER } from '~/platform/live-values';
import type { CatalogVariant } from '~/sellright/types/catalog';

export const ProductMobileBar = component$((props: Record<string, any>) => {
  const {
    allVariantsSoldOut,
    ctaClass,
    ctaDisabled,
    ctaTooltipFading,
    displayPrice,
    handleAddToCart,
    isAddingToCart,
    isOutOfStock,
    isPreOrder,
    product,
    selectedVariant,
    showCtaTooltip,
    showFromPrefix,
    waitlistAvailable,
  } = props;
  // The fixed bar never covers the purchase controls: while an option selector, the pre-order consent or the in-page add button
  // is on screen, the bar steps aside (those controls are then in reach); it returns once they scroll away. Layout only, no data.
  const yielding = useSignal(false);
  const measure = $(() => {
    const vh = window.innerHeight;
    yielding.value = [...document.querySelectorAll('.sr-pdp .sr-sel-group, .sr-pdp .sr-consent, .sr-pdp .sr-cta-desktop, .sr-pdp #sr-pdp-waitlist')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > 72 && r.top < vh;
    });
  });
  useOnWindow('scroll', measure);
  useOnWindow('resize', measure);
  useVisibleTask$(({ track }) => { track(() => props.waitlistAvailable); measure(); }, { strategy: 'document-ready' });
  return (
    <div class={`sr-mobile-bar${yielding.value ? ' is-yielding' : ''}`} aria-hidden={yielding.value ? 'true' : undefined} inert={yielding.value || undefined}>
      <div class="sr-mobile-bar-meta">
        <div class="sr-mobile-bar-name">{product.name}</div>
        <div class="sr-mobile-bar-price">
          {props.pricesPending?.value ? (
            // ADR-0001 DP-1: the shell holds the price's place until the live read lands.
            <span aria-hidden="true" style={{ visibility: 'hidden' }} data-price-pending="">{PRICE_PLACEHOLDER}</span>
          ) : (() => {
            const sv: CatalogVariant | undefined = selectedVariant.value;
            const sale = typeof sv?.salePrice === 'number' && sv.salePrice > 0 ? sv.salePrice : null;
            const pre = typeof sv?.preOrderPrice === 'number' && sv.preOrderPrice > 0 ? sv.preOrderPrice : null;
            const live = isPreOrder.value && pre ? pre : (!isPreOrder.value && sale ? sale : displayPrice.value);
            return <>{showFromPrefix.value && 'From '}${(live / 100).toFixed(0)}</>;
          })()}
        </div>
      </div>
      {allVariantsSoldOut.value ? (
        waitlistAvailable ? (
          <button type="button" class="sr-cta-btn ready" onClick$={() => {
            const target = document.querySelector<HTMLInputElement>('#sr-pdp-waitlist input[type="email"]');
            if (!target) return;
            target.focus({ preventScroll: true });
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}>Notify me</button>
        ) : <button class="sr-cta-btn oos">Out of Stock</button>
      ) : (
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
            <span style="display:inline-flex;width:14px;height:14px;animation:sr-spin 0.7s linear infinite"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg></span>
          ) : ctaDisabled.value ? 'Select options'
            : isOutOfStock.value ? 'Out of Stock'
            : isPreOrder.value ? 'Pre-order now'
            : 'Add to cart'}
        </button>
      )}
    </div>
  );
});
