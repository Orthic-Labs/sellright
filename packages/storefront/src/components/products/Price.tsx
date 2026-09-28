import { component$, Signal } from '@qwik.dev/core';
import { formatPrice } from '~/utils';

interface PriceProps {
  /** Regular unit price, integer cents. Native primary prop. */
  price?: number | null;
  variantSig?: Signal<unknown>;
  forcedClass?: string;
  salePrice?: number | null;
  preOrderPrice?: number | null;
  isPreOrder?: boolean;
  originalPriceClass?: string;
  currencyCode?: string;
  /** @deprecated legacy alias for `price` — kept only for routes/index.tsx and
   *  components/home/HomeTeeSection.tsx (out of scope for this conversion),
   *  which still pass a legacy `priceWithTax` (plain number or, from the
   *  legacy search adapter, a `{min,max}` pair where min always equals max).
   *  New callers should always pass `price` instead. */
  priceWithTax?: number | { min: number; max: number } | { value: number } | null;
}

export default component$<PriceProps>(
  ({
    price,
    variantSig,
    forcedClass,
    salePrice,
    preOrderPrice,
    isPreOrder,
    originalPriceClass,
    currencyCode,
    priceWithTax,
  }) => {
    const renderPrice = (valueInCents: number) => {
      if (typeof valueInCents !== 'number' || valueInCents <= 0) return null;
      return formatPrice(valueInCents, currencyCode);
    };

    const regularCents = price ?? legacyToNumber(priceWithTax);

    const sale = typeof salePrice === 'number' && salePrice > 0 ? salePrice : null;
    const pre = typeof preOrderPrice === 'number' && preOrderPrice > 0 ? preOrderPrice : null;

    let liveCents: number | null = regularCents;
    let strikeCents: number | null = null;
    if (isPreOrder && pre) {
      liveCents = pre;
      if (regularCents !== null && regularCents !== pre) strikeCents = regularCents;
    } else if (!isPreOrder && sale) {
      liveCents = sale;
      if (regularCents !== null && regularCents !== sale) strikeCents = regularCents;
    }

    const liveNode = liveCents && liveCents > 0 ? renderPrice(liveCents) : null;

    return (
      <div class="flex items-center justify-center" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {variantSig?.value != null && <div class="hidden">{JSON.stringify(variantSig.value)}</div>}

        {strikeCents !== null && (
          <div class={`text-sm line-through mr-2 ${originalPriceClass || 'text-white/90'}`}>
            {renderPrice(strikeCents)}
          </div>
        )}

        {liveNode && <div class={forcedClass}>{liveNode}</div>}
      </div>
    );
  },
);

/** @deprecated see `PriceProps.priceWithTax`. */
function legacyToNumber(priceWithTax: PriceProps['priceWithTax']): number | null {
  if (typeof priceWithTax === 'number') return priceWithTax;
  if (priceWithTax && typeof priceWithTax === 'object') {
    if ('value' in priceWithTax && typeof priceWithTax.value === 'number') return priceWithTax.value;
    if ('min' in priceWithTax && typeof priceWithTax.min === 'number') return priceWithTax.min;
  }
  return null;
}
