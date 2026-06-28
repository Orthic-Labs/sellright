import { component$ } from '@qwik.dev/core';
import { titleCase } from './product-options';

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
  } = props;
  return (
    <div class="dd-mobile-bar">
      <div class="dd-mobile-bar-meta">
        <div class="dd-mobile-bar-name">{titleCase(product.name)}</div>
        <div class="dd-mobile-bar-price">
          {(() => {
            const sv: any = selectedVariant.value;
            const cf = sv?.customFields;
            const sale = typeof cf?.salePrice === 'number' && cf.salePrice > 0 ? cf.salePrice : null;
            const pre = typeof cf?.preOrderPrice === 'number' && cf.preOrderPrice > 0 ? cf.preOrderPrice : null;
            const live = isPreOrder.value && pre ? pre : (!isPreOrder.value && sale ? sale : displayPrice.value);
            return <>{showFromPrefix.value && 'From '}${(live / 100).toFixed(0)}</>;
          })()}
        </div>
      </div>
      {allVariantsSoldOut.value ? (
        <button class="dd-cta-btn oos">Out of Stock</button>
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
            <span style="display:inline-flex;width:14px;height:14px;animation:dd-spin 0.7s linear infinite"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg></span>
          ) : ctaDisabled.value ? 'Select options'
            : isOutOfStock.value ? 'Out of Stock'
            : isPreOrder.value ? 'Pre-order now'
            : 'Add to cart'}
        </button>
      )}
    </div>
  );
});
