import type { Variant } from '~/types';

/** Unique option groups in Vendure order */
export function getOptionGroups(variants: Variant[]): { groupName: string; values: string[] }[] {
  const map = new Map<string, string[]>();
  for (const v of variants) {
    for (const opt of (v.options || [])) {
      const g = opt.group?.name || 'Option';
      if (!map.has(g)) map.set(g, []);
      const vals = map.get(g)!;
      if (!vals.includes(opt.name)) vals.push(opt.name);
    }
  }
  const SIZE_ORDER = ['xs', 'xsmall', 'x-small', 's', 'sm', 'small', 'm', 'md', 'medium', 'l', 'lg', 'large', 'xl', 'xxl', '2xl', '3xl'];
  return Array.from(map.entries()).map(([groupName, values]) => {
    if (groupName.toLowerCase() === 'size') {
      values = [...values].sort((a, b) => {
        const ai = SIZE_ORDER.indexOf(a.toLowerCase());
        const bi = SIZE_ORDER.indexOf(b.toLowerCase());
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
    return { groupName, values };
  }).sort((a, b) => a.groupName.localeCompare(b.groupName));
}

/** Values available for groupIndex given prior selections, stock-filtered */
export function availableForGroup(
  variants: Variant[],
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
    const stock = parseInt(v.stockLevel || '0', 10);
    const cf = (v as any).customFields;
    const isPreOrderVariant = !!cf?.isPreOrder;
    if (!isPreOrderVariant && !isNaN(stock) && stock <= 0) continue;
    const opt = v.options.find(o => o.group?.name === groups[groupIndex].groupName);
    if (opt) out.add(opt.name);
  }
  return out;
}

/** Find the resolved variant from all selected values */
export function findVariant(
  variants: Variant[],
  groups: { groupName: string; values: string[] }[],
  selected: (string | null)[],
): Variant | undefined {
  // Single variant with no option groups — return it directly
  if (groups.length === 0) return variants[0];
  if (selected.some(v => !v)) return undefined;
  return variants.find(v =>
    v.options && groups.every((g, i) =>
      v.options!.find(o => o.group?.name === g.groupName)?.name === selected[i]
    )
  );
}

/** Price delta for a value in group 0 vs cheapest overall */
export function priceDeltaLabel(variants: Variant[], groups: { groupName: string; values: string[] }[], value: string): string | null {
  if (groups.length < 2) return null;
  const matching = variants.filter(v => v.options?.find(o => o.group?.name === groups[0].groupName && o.name === value));
  if (!matching.length) return null;
  const groupMin = Math.min(...matching.map(v => v.priceWithTax || v.price || 0));
  const allMin = Math.min(...variants.map(v => v.priceWithTax || v.price || 0));
  const delta = groupMin - allMin;
  if (delta === 0) return null;
  return delta > 0 ? `+$${(delta / 100).toFixed(0)}` : `-$${(Math.abs(delta) / 100).toFixed(0)}`;
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
      <div class="dd-specs">
        <div class="dd-specs-title">Specs</div>
        <dl class="dd-specs-grid">
          <dt>Fabric</dt><dd>280GSM · 50% cotton, 45% polyester, 5% lycra</dd>
          <dt>Print</dt><dd>High density puff screen</dd>
          <dt>Origin</dt><dd>India</dd>
        </dl>
      </div>
      <div class="dd-size-chart">
        <div class="dd-size-chart-title">Size Chart</div>
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
  return html;
}
