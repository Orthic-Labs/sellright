/** Display copy stays separate from ISO timestamps used by fulfillment logic. */
export function shippingDateText(value: { shipDateLabel?: string | null; shipDate?: string | null } | null | undefined, formatDate: (date: string) => string = (date) => date): string | null {
  if (typeof value?.shipDateLabel === 'string' && value.shipDateLabel.length > 0) return value.shipDateLabel;
  return value?.shipDate ? formatDate(value.shipDate) : null;
}
