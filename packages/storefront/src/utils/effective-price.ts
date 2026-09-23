export interface EffectivePriceCustomFields {
  salePrice?: number | null;
  preOrderPrice?: number | null;
  isPreOrder?: boolean | null;
}

// All values in cents. CF prices are stored in minor units (cents) by Vendure's
// `currency-form-input`, same as the native `price` field.
export const effectiveUnitPriceCents = (
  regularCents: number,
  cf: EffectivePriceCustomFields | undefined | null,
): number => {
  if (!cf) return regularCents;
  if (cf.isPreOrder) {
    return typeof cf.preOrderPrice === 'number' && cf.preOrderPrice > 0
      ? cf.preOrderPrice
      : regularCents;
  }
  return typeof cf.salePrice === 'number' && cf.salePrice > 0 ? cf.salePrice : regularCents;
};
