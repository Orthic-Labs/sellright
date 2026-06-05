import { component$, Signal } from '@qwik.dev/core';
import { formatPrice } from '~/utils';

export default component$<{
  priceWithTax: any;
  variantSig?: Signal<unknown>;
  forcedClass?: string;
  salePrice?: number | null;
  preOrderPrice?: number | null;
  isPreOrder?: boolean;
  originalPriceClass?: string;
  currencyCode?: string;
}>(
  ({
    priceWithTax,
    variantSig,
    forcedClass,
    salePrice,
    preOrderPrice,
    isPreOrder,
    originalPriceClass,
    currencyCode,
  }: any) => {
    const renderPrice = (valueInCents: number) => {
      if (typeof valueInCents !== 'number' || valueInCents <= 0) return null;
      return formatPrice(valueInCents, currencyCode);
    };

    const renderPriceRange = (min: number, max: number) => {
      if (min <= 0 && max <= 0) return null;
      return `${formatPrice(min, currencyCode)} - ${formatPrice(max, currencyCode)}`;
    };

    let regularCents: number | null = null;
    let rangeMin: number | null = null;
    let rangeMax: number | null = null;
    if (typeof priceWithTax === 'number') {
      regularCents = priceWithTax;
    } else if (priceWithTax && typeof priceWithTax === 'object') {
      if ('value' in priceWithTax) {
        regularCents = (priceWithTax as any).value ?? null;
      } else if ('min' in priceWithTax && 'max' in priceWithTax) {
        const min = (priceWithTax as any).min as number;
        const max = (priceWithTax as any).max as number;
        if (typeof min === 'number' && typeof max === 'number') {
          if (min === max) {
            regularCents = min;
          } else {
            rangeMin = min;
            rangeMax = max;
          }
        }
      }
    }

    const sale = typeof salePrice === 'number' && salePrice > 0 ? salePrice : null;
    const pre = typeof preOrderPrice === 'number' && preOrderPrice > 0 ? preOrderPrice : null;

    let liveCents: number | null = regularCents;
    let strikeCents: number | null = null;
    if (rangeMin === null) {
      if (isPreOrder && pre) {
        liveCents = pre;
        if (regularCents !== null && regularCents !== pre) strikeCents = regularCents;
      } else if (!isPreOrder && sale) {
        liveCents = sale;
        if (regularCents !== null && regularCents !== sale) strikeCents = regularCents;
      }
    }

    const liveNode = liveCents && liveCents > 0 ? renderPrice(liveCents) : null;

    return (
      <div class="flex items-center justify-center" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {variantSig?.value && <div class="hidden">{JSON.stringify(variantSig.value)}</div>}

        {strikeCents !== null && (
          <div class={`text-sm line-through mr-2 ${originalPriceClass || 'text-white/90'}`}>
            {renderPrice(strikeCents)}
          </div>
        )}

        {(() => {
          if (rangeMin !== null && rangeMax !== null) {
            const range = renderPriceRange(rangeMin, rangeMax);
            return range ? <div class={forcedClass}>{range}</div> : null;
          }
          if (liveNode) {
            return <div class={forcedClass}>{liveNode}</div>;
          }
          return null;
        })()}
      </div>
    );
  },
);
