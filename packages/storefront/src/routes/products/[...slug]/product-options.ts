import type { CatalogVariant } from '~/sellright/types/catalog';
import { effectiveVariantPrice } from '~/sellright/types/catalog';
import { parseSpecBlock, renderSpecBlock } from '~/utils/product-specs';

// getOptionGroups and findVariant live in platform/controllers/product-model.ts (brand views PR2 §5).
import { getOptionGroups, findVariant } from '~/platform/controllers/product-model';
export { getOptionGroups, findVariant };

type PurchasableVariant = Pick<CatalogVariant, 'inStock'> & Partial<Pick<CatalogVariant, 'enabled'>>;
type StockFlags = PurchasableVariant & Pick<CatalogVariant, 'isPreOrder'>;

/** LOCKED stock rule: the live `inStock` read is authoritative. `isPreOrder`
 *  is catalog metadata and can never make a variant purchasable on its own;
 *  anything other than `inStock === true` (missing included) fails closed.
 *  A disabled catalog variant is never purchasable, even with live stock. */
export function isVariantPurchasable(variant: PurchasableVariant | null | undefined): boolean {
  return variant?.inStock === true && variant.enabled !== false;
}

/** A variant is sold as a pre-order only while the live read says it is in
 *  stock. A flagged pre-order with `inStock === false` is simply out of stock. */
export function isActivePreOrder(variant: StockFlags | null | undefined): boolean {
  return !!variant && variant.isPreOrder === true && isVariantPurchasable(variant);
}

/** Pre-order presentation (label, consent, price): the selected variant when
 *  one is resolved, otherwise any variant that is an active pre-order. */
export function isPreOrderPresented(selected: StockFlags | null | undefined, variants: StockFlags[]): boolean {
  if (selected) return isActivePreOrder(selected);
  return variants.some(isActivePreOrder);
}

/** Every variant is out of stock on the live read, pre-order flag or not. */
export function areAllVariantsSoldOut(variants: PurchasableVariant[]): boolean {
  return variants.every((v) => !isVariantPurchasable(v));
}

/** Out of stock only for a complete selection that resolved to a variant whose
 *  live read is not in stock. An incomplete selection is never OOS (it is
 *  simply not yet purchasable) and is never wiped. */
export function isSelectionOutOfStock(
  selectionComplete: boolean,
  selected: PurchasableVariant | null | undefined,
): boolean {
  if (!selectionComplete) return false;
  if (!selected) return false;
  return !isVariantPurchasable(selected);
}

/** Values available for groupIndex given prior selections, stock-filtered.
 *  LOCKED stock rule: every variant needs a live `inStock === true`; the
 *  pre-order flag never makes an out-of-stock variant selectable. */
export function availableForGroup(
  variants: CatalogVariant[],
  groups: { groupName: string; values: string[] }[],
  groupIndex: number,
  selected: (string | null)[],
): Set<string> {
  const out = new Set<string>();
  for (const v of variants) {
    if (!v.options) continue;
    let ok = true;
    for (let i = 0; i < groupIndex; i++) {
      const sel = selected[i];
      if (!sel) { ok = false; break; }
      const opt = v.options.find(o => o.group?.name === groups[i].groupName);
      if (opt?.name !== sel) { ok = false; break; }
    }
    if (!ok) continue;
    if (!isVariantPurchasable(v)) continue;
    const opt = v.options.find(o => o.group?.name === groups[groupIndex].groupName);
    if (opt) out.add(opt.name);
  }
  return out;
}

/** Price delta for a value in group 0 vs cheapest overall (effective prices). */
export function priceDeltaLabel(variants: CatalogVariant[], groups: { groupName: string; values: string[] }[], value: string): string | null {
  if (groups.length < 2) return null;
  const matching = variants.filter(v => v.options?.find(o => o.group?.name === groups[0].groupName && o.name === value));
  if (!matching.length) return null;
  const groupMin = Math.min(...matching.map(effectiveVariantPrice));
  const allMin = Math.min(...variants.map(effectiveVariantPrice));
  const delta = groupMin - allMin;
  if (delta === 0) return null;
  return delta > 0 ? `+$${(delta / 100).toFixed(0)}` : `-$${(Math.abs(delta) / 100).toFixed(0)}`;
}

/** The unit price (cents) the PDP is currently quoting: the pre-order price
 *  on a pre-order, the sale price on a sale variant, otherwise `regular`
 *  (the displayed base/"from" price). Mirrors what the price row renders. */
export function liveUnitPrice(
  variant: Pick<CatalogVariant, 'salePrice' | 'preOrderPrice'> | null | undefined,
  isPreOrder: boolean,
  regular: number,
): number {
  const sale = typeof variant?.salePrice === 'number' && variant.salePrice > 0 ? variant.salePrice : null;
  const pre = typeof variant?.preOrderPrice === 'number' && variant.preOrderPrice > 0 ? variant.preOrderPrice : null;
  if (isPreOrder && pre) return pre;
  if (!isPreOrder && sale) return sale;
  return regular;
}

/** Derive a CSS color from a swatch value name */
export function swatchColor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('black') || n.includes('midnight')) return '#1e1c1a';
  if (n.includes('white') || n.includes('ivory') || n.includes('cloud')) return '#d8d4cc';
  if (n.includes('jade') || n.includes('green') || n.includes('od')) return '#4a6648';
  if (n.includes('grey') || n.includes('gray') || n.includes('smoke')) return '#4a4a50';
  if (n.includes('desert') || n.includes('tan') || n.includes('coyote')) return '#8a7055';
  if (n.includes('slate') || n.includes('blue')) return '#485058';
  if (n.includes('red') || n.includes('crimson')) return '#7a2020';
  if (n.includes('brass') || n.includes('gold')) return '#c8a96e';
  if (n.includes('purple') || n.includes('violet')) return '#5b3a7e';
  return '#888880';
}

/** Title-case a product name (capitalize first letter of each word) */
export function titleCase(str: string): string {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

/** Enhance product description with structured specs/size chart where applicable */
export function enhanceDescription(name: string, html: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('mascot') && lower.includes('tee')) {
    const specs = `
      <div class="sr-specs">
        <div class="sr-specs-title">Specs</div>
        <dl class="sr-specs-grid">
          <dt>Fabric</dt><dd>280GSM · 50% cotton, 45% polyester, 5% lycra</dd>
          <dt>Print</dt><dd>High density puff screen</dd>
          <dt>Origin</dt><dd>India</dd>
        </dl>
      </div>
      <div class="sr-size-chart">
        <div class="sr-size-chart-title">Size Chart</div>
        <table>
          <thead><tr><th>Size</th><th>Length</th><th>Chest</th></tr></thead>
          <tbody>
            <tr><td>S</td><td>29in</td><td>25in</td></tr>
            <tr><td>M</td><td>30in</td><td>27in</td></tr>
            <tr><td>L</td><td>31in</td><td>29in</td></tr>
          </tbody>
        </table>
      </div>`;
    return html + specs;
  }
  const parsed = parseSpecBlock(html);
  return parsed ? `${parsed.intro}${renderSpecBlock(parsed)}` : html;
}
