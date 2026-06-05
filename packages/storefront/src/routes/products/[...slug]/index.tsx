import {
  component$,
  useComputed$,
  useContext,
  useOnDocument,
  useOnWindow,
  useSignal,
  useStore,
  useStyles$,
  useTask$,
  $,
} from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import { OptimizedImage, generateImagePreloadLinks } from '~/components/ui';
import Alert from '~/components/alert/Alert';
import CheckIcon from '~/components/icons/CheckIcon';
import { APP_STATE } from '~/constants';
import { getProductBySlug, getProductBySlugWithCachedVariants, getProductStockLevelsOnly } from '~/providers/shop/products/products';
import { Variant } from '~/types';
import { cleanUpParams } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { generateBreadcrumbSchema, generateProductSchema } from '~/services/seo-api.service';
import type { JsonLdSchema } from '~/types/seo.types';

import { LocalCartService, type LocalCartItem } from '~/services/LocalCartService';
import { useLocalCart, addToLocalCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { useImageGalleryTouchHandling } from '~/utils/optimized-touch-handling';
import { sanitizeProductDescription } from '~/utils/sanitize';

// ─────────────────────────────────────────────────────────────────
// Route loader — manifest-first with API fallback
// ─────────────────────────────────────────────────────────────────
export const useProductLoader = routeLoader$(async ({ params, fail, status }) => {
  const { slug } = cleanUpParams(params);
  if (!slug) {
    status(404);
    return fail(404, { message: 'Product not found: missing slug' });
  }

  // Slug validation: prevent path traversal
  const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;
  if (!SAFE_SLUG.test(slug)) {
    status(404);
    return fail(404, { message: 'Product not found: invalid slug' });
  }

  // Try reading from product JSON file first (metadata only — NO stock in the SSR payload).
  // Variants ship with stockLevel '0' so every option button renders disabled on first paint.
  // Live stock is populated by the client-side refreshLiveStock hook on qidle/focus/visibility,
  // matching Rotten's ShopComponent pattern (fast SSR, progressive enable).
  const CATALOG_DIR = process.env.CATALOG_DIR || '/home/vendure/sites/damned/data';
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(`${CATALOG_DIR}/products/${slug}.json`, 'utf-8');
    const data = JSON.parse(raw);

    return {
      product: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        description: data.description,
        featuredAsset: data.featuredAsset ? { id: 'manifest', preview: data.featuredAsset.preview, name: data.name, source: data.featuredAsset.preview, createdAt: data.lastUpdated, updatedAt: data.lastUpdated, fileSize: 0, height: 0, width: 0, mimeType: 'image/png', type: 'IMAGE', focalPoint: null, customFields: null, tags: [] } : null,
        assets: data.assets.map((a: any, i: number) => ({ id: `asset_${i}`, preview: a.preview, name: `${data.name} ${i}`, source: a.preview, createdAt: data.lastUpdated, updatedAt: data.lastUpdated, fileSize: 0, height: 0, width: 0, mimeType: 'image/png', type: 'IMAGE', focalPoint: null, customFields: null, tags: [] })),
        variants: data.variants.map((v: any) => ({
          id: v.id,
          name: v.name,
          sku: v.sku,
          priceWithTax: v.priceWithTax,
          currencyCode: 'USD',
          options: v.options.map((o: any) => ({ id: o.code, code: o.code, name: o.name, group: { id: o.code, name: o.group, code: o.code }, groupId: o.code })),
          assets: v.assets.map((a: any, i: number) => ({ id: `vasset_${v.id}_${i}`, preview: a.preview })),
          customFields: v.customFields || {},
          // Stock is NEVER in the SSR payload — populated client-side after hydration.
          stockLevel: '0',
        })),
        facetValues: data.facetValues?.map((fv: any) => ({ id: fv.name, name: fv.name, code: fv.name, facet: { id: fv.facetName, name: fv.facetName, code: fv.facetName } })) || [],
        customFields: {},
        hasVariantAssets: Boolean(data.hasVariantAssets),
      },
      source: 'manifest',
      warning: null,
    };
  } catch {
    // File doesn't exist or failed to parse — fall back to API
  }

  // Existing API fallback
  let result;
  try {
    result = await getProductBySlugWithCachedVariants(slug);
    if (!result || !result.product) {
      console.warn('Cache-aware loader failed, falling back to direct query');
      const product = await getProductBySlug(slug);
      if (!product) {
        status(404);
        return fail(404, { message: `Product not found: ${slug}` });
      }
      result = { product, source: 'fallback', warning: null };
    }
  } catch (error) {
    console.error('Product loader error:', error);
    try {
      const product = await getProductBySlug(slug);
      if (!product) {
        status(404);
        return fail(404, { message: `Product not found: ${slug}` });
      }
      result = { product, source: 'error-fallback', warning: 'Data may be outdated due to loading issues' };
    } catch (_fallbackError) {
      status(404);
      return fail(404, { message: `Product not found: ${slug}` });
    }
  }

  const product = result.product;
  if (product && !product.assets) product.assets = [];
  if (product && product.assets.length === 0) {
    product.assets.push({
      __typename: 'Asset' as const,
      id: 'placeholder_1', name: 'placeholder',
      preview: '/asset_placeholder.webp', source: '/asset_placeholder.webp',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      fileSize: 0, height: 400, width: 400, mimeType: 'image/webp',
      type: 'IMAGE' as any, focalPoint: null, customFields: null, tags: [],
    } as any);
  }
  return result;
});

// ─────────────────────────────────────────────────────────────────
// Two-group selector helpers
// ─────────────────────────────────────────────────────────────────

/** Unique option groups in Vendure order */
function getOptionGroups(variants: Variant[]): { groupName: string; values: string[] }[] {
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
function availableForGroup(
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
function findVariant(
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
function priceDeltaLabel(variants: Variant[], groups: { groupName: string; values: string[] }[], value: string): string | null {
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
function swatchColor(name: string): string {
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
function titleCase(str: string): string {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

/** Enhance product description with structured specs/size chart where applicable */
function enhanceDescription(name: string, html: string): string {
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

const PDP_STYLES = `
        /* ── TOKENS ── */
        .dd-pdp {
          --ink: #111110; --mid: #6b6b68; --light: #adadaa;
          --rule: #e4e2dc; --bg: #F7F2EA; --white: #F7F2EA;
          --gold: #965341; --gold-d: #B06B56;
          --img-h: calc(100vh - 64px);
          --gallery-w: calc(var(--img-h) * 0.8);
          --thumb-w: 120px;
          font-family: var(--font-body);
          font-weight: 400;
          background: var(--white);
          color: var(--ink);
          -webkit-font-smoothing: antialiased;
          min-height: 100vh;
        }

        /* ── LAYOUT ── */
        .dd-layout {
          display: grid;
          grid-template-columns: auto 1fr;
          align-items: start;
        }
        .dd-left-col {
          display: flex;
          align-items: flex-start;
          position: sticky;
          top: 64px;
          height: var(--img-h);
          overflow: hidden;
        }

        /* Thumbnail sidebar — full image height */
        .dd-thumb-sidebar {
          width: var(--thumb-w);
          flex-shrink: 0;
          height: 100%;
          overflow-y: auto;
          scrollbar-width: none;
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 6px 6px 6px 10px;
          background: var(--bg);
        }
        .dd-thumb-sidebar::-webkit-scrollbar { display: none; }

        /* Desktop gallery — scrollable, 4:5 aspect ratio */
        .dd-gallery-wrap {
          flex: 1;
          max-width: calc(var(--img-h) * 0.8);
          height: 100%;
          overflow-y: auto;
          scrollbar-width: none;
          margin-left: 4px;
        }
        .dd-gallery-wrap::-webkit-scrollbar { display: none; }

        .dd-gallery-item {
          position: relative;
          height: var(--img-h);
          cursor: zoom-in;
        }
        .dd-gallery-item img,
        .dd-gallery-item .opt-img {
          width: 100%; height: 100%;
          object-fit: cover; object-position: 50% 50%;
          display: block;
        }
        .dd-thumb-sidebar-btn {
          width: 100%;
          aspect-ratio: 4/5;
          overflow: hidden;
          background: var(--bg);
          border: 1.5px solid transparent;
          padding: 0;
          cursor: pointer;
          position: relative;
          flex-shrink: 0;
          transition: border-color 0.15s;
          border-radius: 0;
        }
        .dd-thumb-sidebar-btn:hover { border-color: var(--light); }
        .dd-thumb-sidebar-btn.active {
          border-color: var(--ink);
        }
        .dd-thumb-sidebar-btn img,
        .dd-thumb-sidebar-btn .opt-img {
          width: 100%; height: 100%;
          object-fit: cover; object-position: 50% 50%; display: block;
        }


        .dd-img-loading {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          background: rgba(250,250,248,0.8); z-index: 5;
        }
        .dd-spinner {
          width: 28px; height: 28px; border-radius: 50%;
          border: 2px solid var(--rule); border-top-color: var(--ink);
          animation: dd-spin 0.7s linear infinite;
        }
        @keyframes dd-spin { to { transform: rotate(360deg); } }

        .dd-badge {
          position: absolute; top: 0; left: 0; z-index: 10;
          padding: 6px 14px;
          font-size: 13px; letter-spacing: 2.5px; text-transform: uppercase;
          font-weight: 400; font-family: var(--font-heading);
        }
        .dd-badge-preorder { background: var(--ink); color: var(--gold); }
        .dd-badge-soldout  { background: var(--ink); color: var(--white); }

        .dd-enlarge-hint {
          display: none; position: absolute; inset: 0;
          align-items: center; justify-content: center;
          pointer-events: none;
        }
        .dd-gallery-item:hover .dd-enlarge-hint { display: flex; }
        .dd-enlarge-label {
          background: rgba(0,0,0,0.5); color: rgba(255,255,255,0.85);
          padding: 5px 12px;
          font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase;
          font-family: var(--font-heading);
        }

        /* thumb-strip removed — replaced by dd-thumb-sidebar */

        /* Mobile carousel */
        .dd-mobile-carousel {
          display: none; position: relative;
          overflow: hidden; background: #1a1a18; aspect-ratio: 4/5;
        }
        .dd-mobile-carousel img {
          width: 100%; height: 100%;
          object-fit: cover; object-position: 50% 50%; display: block;
        }
        .dd-carousel-btn {
          position: absolute; top: 50%; transform: translateY(-50%);
          z-index: 20; width: 44px; height: 44px;
          background: none; border: none; cursor: pointer;
          color: rgba(255,255,255,0.65);
          display: flex; align-items: center; justify-content: center;
          filter: drop-shadow(0 1px 4px rgba(0,0,0,0.45));
        }
        .dd-carousel-btn-prev { left: 8px; }
        .dd-carousel-btn-next { right: 8px; }
        .dd-carousel-dots {
          position: absolute; bottom: 10px; left: 0; right: 0;
          display: flex; justify-content: center; gap: 5px;
        }
        .dd-dot {
          width: 6px; height: 6px;
          background: rgba(255,255,255,0.4);
          border: none; padding: 8px; cursor: pointer; transition: opacity 0.2s, background-color 0.2s;
          background-clip: content-box;
        }
        .dd-dot.active { width: 18px; background: rgba(255,255,255,0.9); background-clip: content-box; }
        .dd-mobile-dots {
          display: none;
          justify-content: center; align-items: center;
          gap: 8px; padding: 12px 0;
        }
        .dd-mobile-dot {
          width: 8px; height: 8px; border-radius: 50%;
          border: none; padding: 8px; cursor: pointer;
          background: #c8c8c8; transition: opacity 0.2s, background-color 0.2s;
          background-clip: content-box;
        }
        .dd-mobile-dot.active { background: var(--ink); transform: scale(1.2); background-clip: content-box; }

        /* ── RIGHT: INFO ── */
        .dd-info-col {
          background: var(--white);
          padding: 40px 44px 120px;
        }

        .dd-kicker {
          display: flex; align-items: center; gap: 10px;
          font-size: 13px; letter-spacing: 3px; text-transform: uppercase;
          color: var(--gold); margin-bottom: 12px;
        }
        .dd-kicker::before {
          content: ''; width: 20px; height: 1px;
          background: var(--gold); flex-shrink: 0;
        }
        .dd-title {
          font-family: var(--font-heading);
          font-weight: 700; font-size: 40px;
          line-height: 0.95; letter-spacing: -0.5px;
          color: var(--ink); margin-bottom: 20px;
        }
        .dd-price-badge {
          font-family: var(--font-heading); font-weight: 400;
          font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--gold); align-self: center;
        }
        .dd-price-row {
          display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px;
        }
        .dd-price-from {
          font-size: 13px; letter-spacing: 1.5px;
          text-transform: uppercase; color: var(--light);
        }
        .dd-price {
          font-family: var(--font-heading);
          font-size: 22px; font-weight: 600; color: var(--ink);
          font-variant-numeric: tabular-nums;
          transition: color 0.2s;
        }
        .dd-price-original {
          font-family: var(--font-heading);
          font-size: 1rem; font-weight: 600; color: var(--ink); opacity: 0.4;
          text-decoration: line-through;
          font-variant-numeric: tabular-nums;
        }
        .dd-price-note {
          font-size: 13px; letter-spacing: 0.8px;
          text-transform: uppercase; color: var(--light); margin-bottom: 24px;
        }
        .dd-sezzle-inline {
          font-size: 13px; color: var(--light); margin-bottom: 6px;
          line-height: 1.6;
        }
        .dd-sezzle-inline strong { color: var(--mid); font-weight: 500; }
        .dd-sezzle-inline a { text-decoration: none; }
        .dd-sezzle-inline a:hover { opacity: 0.7; }
        .dd-rule { height: 1px; background: var(--rule); margin: 22px 0; }

        /* ── SELECTOR ── */
        .dd-sel-group { }
        @keyframes dd-fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .dd-sel-head {
          display: flex; align-items: baseline;
          justify-content: space-between; margin-bottom: 14px;
        }
        .dd-sel-label {
          font-size: 13px; letter-spacing: 3px;
          text-transform: uppercase; color: var(--ink); font-weight: 600;
        }
        .dd-sel-chosen {
          font-family: var(--font-heading);
          font-style: normal; font-weight: 400; font-size: 14px; color: var(--ink);
        }

        /* Blade cards */
        .dd-blade-grid {
          display: grid;
          gap: 0;
        }
        .dd-blade-card {
          background: var(--white); padding: 10px 14px;
          cursor: pointer; position: relative;
          transition: background-color 0.15s, color 0.15s, border-color 0.15s, transform 0.15s; text-align: center;
          height: 44px; display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 6px;
          border: 1.5px solid #c8c5bc;
          margin-left: -1.5px; /* collapse double borders */
        }
        .dd-blade-card:first-child { margin-left: 0; }
        .dd-blade-card:hover {
          border-color: rgba(184,115,51,0.5);
          background: rgb(240,235,225);
          transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
        }
        .dd-blade-card.active {
          background: rgba(184,115,51,0.06); border-color: var(--gold);
          z-index: 1;
        }
        .dd-blade-card.oos { opacity: 0.35; pointer-events: none; }
        .dd-blade-name {
          font-size: 13px; letter-spacing: 2px; text-transform: uppercase;
          color: var(--ink); font-weight: 500;
          font-family: var(--font-heading);
        }
        .dd-blade-delta {
          font-family: var(--font-heading);
          font-size: 13px; color: var(--mid);
        }
        .dd-blade-delta.plus { color: var(--gold); }

        /* Swatches */
        .dd-swatch-grid { display: flex; flex-wrap: wrap; gap: 12px; }
        .dd-swatch-btn {
          display: flex; flex-direction: column; align-items: center;
          gap: 6px; cursor: pointer; background: none; border: none; padding: 0;
          opacity: 0.5; transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }
        .dd-swatch-btn.active { opacity: 1; }
        .dd-swatch-btn:hover:not(.active):not(.oos) { opacity: 0.85; }
        .dd-swatch {
          width: 48px; height: 48px;
          border: 2px solid transparent; position: relative;
          transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
        }
        .dd-swatch-btn.active .dd-swatch {
          border-color: var(--gold);
          outline: 2px solid var(--gold); outline-offset: 2px;
        }
        .dd-swatch-btn:hover:not(.active):not(.oos) .dd-swatch {
          border-color: rgba(184,115,51,0.4);
        }
        .dd-swatch-btn.oos { opacity: 0.35; pointer-events: none; }
        .dd-swatch:active { transform: scale(0.96); }
        .dd-swatch-btn.oos .dd-swatch::after {
          content: ''; position: absolute; inset: 0;
          background: repeating-linear-gradient(
            -45deg, transparent, transparent 4px,
            rgba(255,255,255,0.55) 4px, rgba(255,255,255,0.55) 5px
          );
        }
        .dd-swatch-name {
          font-size: 13px; letter-spacing: 0.8px; text-transform: uppercase;
          color: var(--ink); font-weight: 500;
          text-align: center; transition: color 0.15s;
        }

        /* Pills */
        .dd-pill-grid {
          display: flex; flex-wrap: wrap; gap: 8px;
        }
        .dd-pill {
          padding: 0 16px; height: 44px;
          background: var(--white);
          border: 1.5px solid #c8c5bc;
          cursor: pointer; transition: background-color 0.15s, color 0.15s, border-color 0.15s, transform 0.15s;
          font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase;
          color: var(--ink); font-weight: 500;
          font-family: var(--font-heading); white-space: nowrap;
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          flex-grow: 1; min-width: fit-content;
        }
        .dd-pill:hover {
          border-color: rgba(184,115,51,0.5);
          background: rgb(240,235,225);
          transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
        }
        .dd-pill.active { background: rgba(184,115,51,0.06); border-color: var(--gold); position: relative; }
        .dd-pill.oos { opacity: 0.35; pointer-events: none; text-decoration: line-through; }
        .dd-pill:active { transform: scale(0.96); }
        .dd-pill-price { font-size: 13px; color: var(--ink); opacity: 0.6; font-weight: 400; letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; }

        /* Step connector */
        .dd-connector {
          display: flex; align-items: center; gap: 10px; margin: 18px 0;
        }
        .dd-connector-line { flex: 1; height: 1px; background: var(--rule); }
        .dd-connector-word {
          font-size: 13px; letter-spacing: 2px;
          text-transform: uppercase; color: var(--light);
        }

        /* ── CTA ── */
        .dd-consent {
          display: flex; align-items: flex-start; gap: 10px;
          margin-bottom: 12px; padding: 12px;
          background: var(--bg); border: 1px solid var(--rule);
        }
        .dd-consent input[type="checkbox"] {
          width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px;
          cursor: pointer; accent-color: var(--gold);
          border: 2px solid var(--ink) !important; border-radius: 2px;
          appearance: auto;
        }
        .dd-consent-text { font-size: 13px; color: var(--mid); line-height: 1.6; }

        .dd-cta-btn {
          width: 100%; padding: 17px 24px; min-height: 52px;
          font-family: var(--font-heading); font-weight: 400;
          font-size: 14px; letter-spacing: 2.5px; text-transform: uppercase;
          cursor: pointer; border: none; transition: background-color 0.2s, transform 0.15s;
          display: flex; align-items: center; justify-content: center; gap: 12px;
        }
        .dd-cta-btn.ready { background: var(--gold); color: #fff; }
        .dd-cta-btn.ready:hover { background: var(--gold-d); color: #fff; }
        .dd-cta-btn.preorder { background: var(--ink); color: var(--gold); }
        .dd-cta-btn.preorder:hover { background: #1e1d1c; }
        .dd-cta-btn.disabled {
          background: var(--gold); color: #fff; border: none;
        }
        .dd-cta-btn.disabled:hover { background: var(--gold-d); color: #fff; }
        .dd-cta-btn.oos {
          background: #f0eeea; color: #aaa;
          cursor: default; border: none;
        }
        .dd-cta-btn.oos:hover { background: #f0eeea; }
        .dd-cta-btn:active { transform: scale(0.96); }
        .dd-cta-wrap { position: relative; }
        .dd-cta-tooltip {
          position: absolute; left: 50%; bottom: calc(100% + 8px);
          transform: translateX(-50%);
          background: rgba(17,17,16,0.88); color: rgba(255,255,255,0.85);
          font-family: var(--font-body);
          font-size: 13px; letter-spacing: 0.3px;
          padding: 6px 10px; border-radius: 4px;
          white-space: nowrap; pointer-events: none;
          opacity: 1; transition: opacity 0.4s ease;
          z-index: 5;
        }
        .dd-cta-tooltip.fade-out { opacity: 0; }
        .dd-ship-note {
          font-size: 13px; letter-spacing: 1px; color: var(--light);
          text-transform: uppercase; margin-top: 6px;
        }
        .dd-cta-arrow {
          width: 16px; height: 1px; background: currentColor;
          position: relative; flex-shrink: 0;
        }
        .dd-cta-arrow::after {
          content: ''; position: absolute; right: -1px; top: -3.5px;
          width: 7px; height: 7px;
          border-top: 1px solid currentColor; border-right: 1px solid currentColor;
          transform: rotate(45deg);
        }

        /* ── TRUST BAR ── */
        .dd-trust { display: flex; border: 1px solid var(--rule); margin-top: 18px; }
        .dd-trust-item {
          flex: 1; padding: 10px 12px; border-right: 1px solid var(--rule);
          display: flex; align-items: center; gap: 10px;
        }
        .dd-trust-item:last-child { border-right: none; }
        .dd-trust-icon { width: 18px; height: 18px; flex-shrink: 0; color: var(--gold); }
        .dd-trust-text { display: flex; flex-direction: column; gap: 2px; }
        .dd-trust-val {
          font-size: 13px; letter-spacing: 0.8px; text-transform: uppercase;
          color: var(--mid); font-weight: 500;
        }
        .dd-trust-lbl { font-size: 13px; color: var(--light); }

        /* ── DESCRIPTION ── */
        .dd-desc { font-size: 15px; color: rgb(70,70,67); line-height: 1.75; }
        .dd-desc p { margin-bottom: 10px; }
        .dd-desc p:last-child { margin-bottom: 0; }

        /* Specs block */
        .dd-specs { margin: 16px 0; }
        .dd-specs-title {
          font-family: var(--font-heading); font-weight: 400;
          font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--mid); margin-bottom: 10px;
        }
        .dd-specs-grid {
          display: grid; grid-template-columns: auto 1fr; gap: 0;
          border-top: 1px solid var(--rule);
        }
        .dd-specs-grid dt {
          font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
          color: var(--light); padding: 8px 16px 8px 0;
          border-bottom: 1px solid var(--rule);
        }
        .dd-specs-grid dd {
          font-size: 13px; color: var(--mid); padding: 8px 0;
          border-bottom: 1px solid var(--rule); margin: 0;
        }

        /* Size chart table */
        .dd-size-chart { margin: 16px 0; }
        .dd-size-chart-title {
          font-family: var(--font-heading); font-weight: 400;
          font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--mid); margin-bottom: 10px;
        }
        .dd-size-chart table {
          width: 100%; border-collapse: collapse;
          font-size: 13px; color: var(--mid);
        }
        .dd-size-chart th {
          font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
          color: var(--light); text-align: left; padding: 8px 12px;
          border-bottom: 1px solid var(--rule); font-weight: 500;
        }
        .dd-size-chart td {
          padding: 8px 12px; border-bottom: 1px solid var(--rule);
        }
        .dd-desc table {
          width: 100%; border-collapse: collapse; margin: 12px 0;
          font-size: 13px; color: var(--mid);
        }
        .dd-desc th {
          font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
          color: var(--light); text-align: left; padding: 8px 12px;
          border-bottom: 1px solid var(--rule); font-weight: 500;
        }
        .dd-desc td {
          padding: 8px 12px; border-bottom: 1px solid var(--rule);
        }

        /* ── PRE-ORDER NOTICE ── */
        .dd-po-notice {
          margin-top: 16px; padding: 14px;
          background: var(--bg); border: 1px solid var(--rule);
          display: flex; gap: 12px; align-items: flex-start;
        }
        .dd-po-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--gold); flex-shrink: 0; margin-top: 5px;
          animation: dd-pulse 2s infinite;
        }
        @keyframes dd-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .dd-po-text { font-size: 13px; color: var(--mid); line-height: 1.7; }
        .dd-po-text strong { color: var(--ink); font-weight: 500; }

        /* ── IMAGE MODAL — full-screen takeover ── */
        .dd-modal {
          position: fixed; inset: 0; z-index: 9999;
          background: #000;
          display: flex; align-items: center; justify-content: center;
        }
        .dd-modal-close {
          position: absolute; top: 16px; right: 16px;
          top: max(16px, env(safe-area-inset-top, 16px));
          background: none; border: none; cursor: pointer;
          color: rgba(255,255,255,0.6); font-size: 24px; line-height: 1;
          transition: color 0.15s;
          min-width: 44px; min-height: 44px;
          display: flex; align-items: center; justify-content: center;
          z-index: 10;
        }
        .dd-modal-close:hover { color: rgba(255,255,255,0.9); }
        .dd-modal-inner {
          position: relative;
          width: 100%; height: 100%;
          display: flex; align-items: center; justify-content: center;
          padding: env(safe-area-inset-top, 0) 0 env(safe-area-inset-bottom, 0);
        }
        .dd-modal-inner picture {
          display: flex; align-items: center; justify-content: center;
          width: 100%; height: 100%;
        }
        .dd-modal-inner img, .dd-modal-inner .opt-img {
          width: 100%; height: 100%;
          object-fit: contain; display: block;
        }
        .dd-modal-nav {
          position: absolute; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer;
          color: rgba(255,255,255,0.5);
          min-width: 44px; min-height: 44px;
          display: flex; align-items: center; justify-content: center;
          transition: color 0.15s;
          z-index: 10;
        }
        .dd-modal-nav:hover { color: rgba(255,255,255,1); }
        .dd-modal-prev { left: 8px; }
        .dd-modal-next { right: 8px; }
        .dd-modal-counter {
          position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
          top: max(16px, env(safe-area-inset-top, 16px));
          font-size: 13px; letter-spacing: 2px; text-transform: uppercase;
          color: rgba(255,255,255,0.4);
          z-index: 10;
        }

        /* ── MOBILE FIXED ATC BAR ── */
        .dd-mobile-bar {
          display: none;
          position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
          background: var(--white); border-top: 1px solid var(--rule);
          padding: 12px 16px;
          padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
          align-items: center; gap: 12px;
        }
        .dd-mobile-bar-meta { flex: 1; min-width: 0; }
        .dd-mobile-bar-name {
          font-family: var(--font-heading);
          font-size: 14px; font-weight: 700; color: var(--ink);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .dd-mobile-bar-price { font-size: 13px; color: var(--mid); font-variant-numeric: tabular-nums; }
        .dd-mobile-bar .dd-cta-btn {
          width: auto; flex-shrink: 0; padding: 14px 18px;
        }

        /* ── RESPONSIVE ── */
        @media (max-width: 1024px) {
          .dd-layout { display: block; }
          .dd-left-col { display: block; position: static; height: auto; overflow: visible; }
          .dd-thumb-sidebar { display: none; }
          .dd-gallery-wrap { display: none; }
          .dd-mobile-carousel { display: block; position: sticky; top: 64px; z-index: 10; }
          .dd-mobile-dots { display: flex; }
          .dd-info-col {
            min-width: 0; max-width: none; width: 100%;
            border-left: none;
            padding: 20px 16px;
            padding-bottom: calc(80px + env(safe-area-inset-bottom, 16px));
          }
          .dd-title { font-size: 28px; }
          .dd-cta-desktop { display: none; }
          .dd-mobile-bar { display: flex; }
        }
        /* Tablet — cap carousel height so product info is visible above fold */
        @media (min-width: 600px) and (max-width: 1024px) {
          .dd-mobile-carousel {
            aspect-ratio: 16/10;
            position: relative;
            top: auto;
          }
          .dd-info-col {
            padding: 28px 32px;
            padding-bottom: calc(80px + env(safe-area-inset-bottom, 16px));
            max-width: 720px;
            margin: 0 auto;
          }
          .dd-title { font-size: 32px; }
` as const;

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────
export default component$(() => {
  useStyles$(PDP_STYLES);
  const appState = useContext(APP_STATE);
  const localCart = useLocalCart();
  const loaderData = useProductLoader();
  const loaderResult = loaderData.value;

  // Handle 404 / failed loader
  if (!loaderResult || (loaderResult as any).message || !(loaderResult as any).product) {
    return (
      <div class="min-h-[50vh] flex flex-col items-center justify-center py-16 px-4">
        <h1 class="text-2xl font-bold text-gray-900 mb-3">Product Not Found</h1>
        <p class="text-gray-500 mb-6">This product may have been discontinued or is no longer available.</p>
        <a href="/shop" class="inline-flex items-center px-6 py-2.5 bg-black text-white text-sm font-medium uppercase tracking-wider hover:bg-gray-800 transition-colors">Browse Products</a>
      </div>
    );
  }

  const product = useStore(loaderResult.product || loaderResult);

  if (!product || !product.assets || !product.variants || product.variants.length === 0) {
    return <div class="text-center py-8">Product not found</div>;
  }

  const isEnhancing = useSignal(false);
  const enhancementError = useSignal<string | null>(null);

  // ── Image state ──────────────────────────────────────────────
  const currentImageSig = useSignal(
    product.featuredAsset ||
      (product.assets.length > 0 ? product.assets[0] : { id: '', preview: '/asset_placeholder.webp', name: 'Placeholder' }),
  );
  const currentImageIndex = useSignal(0);

  // ── Variant selector state (declared early so orderedAssets can read them) ──
  const groups = useComputed$(() => getOptionGroups(product.variants));
  const selectedValues = useSignal<(string | null)[]>([]);

  const hasVariantAssets = Boolean((product as any).hasVariantAssets) ||
    (product.variants || []).some((v: any) => (v.assets?.length || 0) > 0);

  // Base gallery list (featuredAsset first). Plain const — same for every render.
  const baseGalleryList: any[] = (() => {
    if (!product.featuredAsset || !product.assets) return product.assets || [];
    const idx = product.assets.findIndex(
      (a: any) => a.id === product.featuredAsset?.id || a.preview === product.featuredAsset?.preview,
    );
    if (idx === -1) return [product.featuredAsset, ...product.assets];
    if (idx === 0) return product.assets;
    const arr = [...product.assets];
    const [f] = arr.splice(idx, 1);
    return [f, ...arr];
  })();

  // Variant-aware ordered assets. Plain useSignal seeded with base product list.
  // Updated imperatively from handleGroupSelect$ when the user picks a Blade.
  const orderedAssets = useSignal<any[]>(baseGalleryList);

  const showImageModal = useSignal(false);
  const modalImageSrc = useSignal('');
  const isImageLoading = useSignal(false);
  const modalImageIndex = useSignal(0);

  const openImageModal = $((imageSrc: string, imageIndex?: number) => {
    modalImageSrc.value = imageSrc;
    modalImageIndex.value = imageIndex ?? orderedAssets.value.findIndex(
      (a: any) => a.preview === imageSrc.replace(/\?preset=modal$/, ''),
    );
    showImageModal.value = true;
    isImageLoading.value = true;
    setTimeout(() => { isImageLoading.value = false; }, 150);
    document.body.style.overflow = 'hidden';
  });

  const closeImageModal = $(() => {
    showImageModal.value = false;
    modalImageSrc.value = '';
    isImageLoading.value = false;
    document.body.style.overflow = 'unset';
  });

  const navigateModal = $((direction: 'prev' | 'next') => {
    const len = orderedAssets.value.length;
    const newIndex = direction === 'next'
      ? (modalImageIndex.value + 1) % len
      : (modalImageIndex.value - 1 + len) % len;
    const newAsset = orderedAssets.value[newIndex];
    modalImageIndex.value = newIndex;
    modalImageSrc.value = newAsset.preview.includes('asset_placeholder')
      ? newAsset.preview : newAsset.preview + '?preset=modal';
    isImageLoading.value = true;
    setTimeout(() => { isImageLoading.value = false; }, 150);
    currentImageSig.value = newAsset;
  });

  // Handler for variant group selection — defined at component level so only signals cross the $() boundary
  const handleGroupSelect$ = $((e: Event) => {
    const btn = (e.target as HTMLElement).closest('[data-group-name]') as HTMLElement;
    if (!btn) return;
    const name = btn.dataset.groupName!;
    const val = btn.dataset.val!;
    const isReset = btn.dataset.reset === '1';
    const idx = groups.value.findIndex(g => g.groupName === name);
    if (isReset) {
      const next = Array(groups.value.length).fill(null);
      next[idx] = val;
      selectedValues.value = next;
    } else {
      const next = [...selectedValues.value];
      next[idx] = val;
      selectedValues.value = next;
    }

    // Imperative gallery swap — when the first option group changes, compute the
    // variant asset union and write orderedAssets directly. No useTask$/useComputed$
    // because Qwik beta.32 SPA-nav reactivity is unreliable for this subtree.
    if (idx === 0 && hasVariantAssets) {
      const firstGroupName = groups.value[0]?.groupName;
      const firstSel = val;
      let list: any[] = baseGalleryList;
      if (firstGroupName && firstSel) {
        const seen = new Set<string>();
        const union: any[] = [];
        for (const v of product.variants as Variant[]) {
          const match = v.options?.some(
            (o: any) => o.group?.name === firstGroupName && o.name === firstSel,
          );
          if (!match) continue;
          for (const a of (v.assets || [])) {
            if (a?.preview && !seen.has(a.preview)) {
              seen.add(a.preview);
              union.push(a);
            }
          }
        }
        if (union.length > 0) list = union;
      }
      orderedAssets.value = list;
      currentImageSig.value = list[0];
      currentImageIndex.value = 0;
    }
  });

  // T8 (PDP): keydown for image modal — via useOnDocument
  useOnDocument('keydown', $((event: Event) => {
    const e = event as KeyboardEvent;
    if (!showImageModal.value) return;
    switch (e.key) {
      case 'Escape': closeImageModal(); break;
      case 'ArrowLeft': if (orderedAssets.value.length > 1) navigateModal('prev'); break;
      case 'ArrowRight': if (orderedAssets.value.length > 1) navigateModal('next'); break;
    }
  }));

  // Live stock refresh — always hits backend, no debounce, no sessionStorage cache.
  // Runs on qidle (initial) and whenever the tab regains focus/visibility.
  const refreshLiveStock = $(async () => {
    isEnhancing.value = true;
    enhancementError.value = null;
    try {
      const result: any = await getProductStockLevelsOnly(product.slug);
      const liveVariants: Array<{ id: string; stockLevel: string }> = result?.product?.variants || [];
      if (!liveVariants.length) return;
      const stockById = new Map(liveVariants.map(v => [String(v.id), v.stockLevel]));
      product.variants = (product.variants || []).map((v: any) => ({
        ...v,
        stockLevel: stockById.get(String(v.id)) ?? '0',
      }));
      // Only reset when the user has made a COMPLETE selection that can no longer
      // resolve to a variant (e.g. variant got removed). A partial in-progress
      // selection (step 1 chosen, step 2 pending) must never be wiped here —
      // that blows up mid-selection UX when focus/visibility triggers a refresh.
      const isCompleteSelection =
        groups.value.length > 0 &&
        selectedValues.value.length === groups.value.length &&
        selectedValues.value.every(v => v !== null);
      if (isCompleteSelection) {
        const resolved = findVariant(product.variants, groups.value, selectedValues.value);
        if (!resolved) {
          selectedValues.value = Array(groups.value.length).fill(null);
        }
      }
    } catch (error) {
      console.error('[PDP] Live stock refresh failed:', error);
      enhancementError.value = 'Failed to refresh stock';
    } finally {
      isEnhancing.value = false;
    }
  });

  // Single stock refresh on first idle. Cart open, checkout entry, and placeOrder all
  // re-check stock on their own; users who keep the PDP open and miss a sellout will see
  // OOS at cart-add time, which is acceptable.
  useOnDocument('qidle', $(() => { refreshLiveStock(); }));

  // ── Touch handling — identical to original ───────────────────
  const changeImage = $((newIndex: number) => {
    const newAsset = orderedAssets.value[newIndex];
    if (newAsset) {
      currentImageSig.value = newAsset;
    }
  });

  useTask$(({ track }) => {
    track(() => currentImageSig.value);
    track(() => orderedAssets.value);
    const list = orderedAssets.value;
    if (list.length === 0) return;
    const index = list.findIndex(
      (a: any) => a.id === currentImageSig.value.id || a.preview === currentImageSig.value.preview,
    );
    if (index === -1) {
      currentImageSig.value = list[0];
      currentImageIndex.value = 0;
    } else {
      currentImageIndex.value = index;
    }
  });

  // ── Desktop gallery scroll ────────────────────────────────────
  const galleryRef = useSignal<Element>();

  const scrollToImage = $((index: number) => {
    if (galleryRef.value) {
      const el = galleryRef.value as HTMLElement;
      el.scrollTo({ top: index * el.clientHeight, behavior: 'smooth' });
    }
    currentImageIndex.value = index;
    currentImageSig.value = orderedAssets.value[index];
  });

  const handleGalleryScroll = $((e: Event) => {
    const el = e.target as HTMLElement;
    const idx = Math.round(el.scrollTop / el.clientHeight);
    if (idx !== currentImageIndex.value && idx < orderedAssets.value.length) {
      currentImageIndex.value = idx;
      currentImageSig.value = orderedAssets.value[idx];
    }
  });

  // Handlers for image gallery buttons — avoids .map() params crossing $() boundary
  const handleThumbClick$ = $((e: Event) => {
    const idx = Number((e.target as HTMLElement).closest('[data-idx]')?.getAttribute('data-idx'));
    if (!isNaN(idx)) scrollToImage(idx);
  });
  const handleGalleryItemClick$ = $((e: Event) => {
    const el = (e.target as HTMLElement).closest('[data-idx]') as HTMLElement;
    if (!el) return;
    const idx = Number(el.dataset.idx);
    const src = el.dataset.src || '';
    openImageModal(src, idx);
  });
  const handleDotClick$ = $((e: Event) => {
    const idx = Number((e.target as HTMLElement).closest('[data-idx]')?.getAttribute('data-idx'));
    if (!isNaN(idx)) changeImage(idx);
  });

  const { handleTouchStart$, handleTouchMove$, handleTouchEnd$, touchState: _touchState } =
    useImageGalleryTouchHandling(orderedAssets, currentImageIndex, changeImage);

  // ── Two-group progressive selector (continued) ──────────────

  // Initialise array length when groups load
  useTask$(({ track }) => {
    track(() => groups.value.length);
    if (selectedValues.value.length !== groups.value.length)
      selectedValues.value = Array(groups.value.length).fill(null);
  });

  // No auto-select — user must choose a variant explicitly
  // This ensures the CTA starts in .disabled state showing "Add to Cart"

  const resolvedVariant = useComputed$(() =>
    findVariant(product.variants, groups.value, selectedValues.value)
  );

  // Keep legacy signals for cart / sezzle / existing price logic
  const selectedVariantIdSignal = useSignal<string | undefined>(undefined);
  useTask$(({ track }) => {
    track(() => resolvedVariant.value);
    selectedVariantIdSignal.value = resolvedVariant.value?.id;
  });

  const availableVariants = useComputed$(() => product.variants);

  const selectedVariant = useComputed$(() =>
    availableVariants.value.find((v: Variant) => v.id === selectedVariantIdSignal.value)
  );

  const isPreOrder = useComputed$(() => {
    if (selectedVariant.value) {
      return !!(selectedVariant.value as any)?.customFields?.isPreOrder;
    }
    // Fallback: any variant flagged
    return product.variants.some((v: any) => !!v.customFields?.isPreOrder);
  });

  const hasSale = useComputed$(() => {
    if (selectedVariant.value) {
      const p = selectedVariant.value?.customFields?.salePrice;
      return typeof p === 'number' && p > 0;
    }
    // Fallback: check any variant
    return product.variants.some((v: any) => typeof v.customFields?.salePrice === 'number' && v.customFields.salePrice > 0);
  });

  const allVariantsSoldOut = useComputed$(() =>
    product.variants.every((v: Variant) => {
      const stock = parseInt((v as any).stockLevel || '0', 10);
      const cf = (v as any).customFields;
      return !cf?.isPreOrder && stock <= 0;
    })
  );

  // Only evaluate OOS when ALL groups have a chosen value
  const allGroupsSelected = useComputed$(() =>
    groups.value.length > 0 && selectedValues.value.length === groups.value.length && selectedValues.value.every(v => v !== null)
  );
  const isOutOfStock = useComputed$(() => {
    if (!allGroupsSelected.value) return false; // incomplete selection — never OOS
    if (!selectedVariant.value) return false;
    if (isPreOrder.value) return false;
    return parseInt(selectedVariant.value?.stockLevel || '0', 10) <= 0;
  });

  const preOrderConsent = useSignal(false);
  const showCtaTooltip = useSignal(false);
  const ctaTooltipFading = useSignal(false);

  // ── Cart — identical to original ─────────────────────────────
  const addItemToOrderErrorSignal = useSignal('');
  const isAddingToCart = useSignal(false);
  const quantitySignal = useSignal<Record<string, number>>({});

  const handleAddToCart = $(async () => {
    if (!isOutOfStock.value) {
      try {
        isAddingToCart.value = true;
        const selectedVar = selectedVariant.value;
        if (!selectedVar) throw new Error('No variant selected');

        const rawSalePrice = selectedVar.customFields?.salePrice;
        const rawPreOrderPrice = selectedVar.customFields?.preOrderPrice;
        const effectiveSalePrice = typeof rawSalePrice === 'number' && rawSalePrice > 0 ? rawSalePrice : undefined;
        const effectivePreOrderPrice = typeof rawPreOrderPrice === 'number' && rawPreOrderPrice > 0 ? rawPreOrderPrice : undefined;

        const localCartItem: LocalCartItem = {
          productVariantId: selectedVar.id,
          quantity: 1,
          isPreOrder: isPreOrder.value,
          shipDate: selectedVar.customFields?.shipDate,
          salePrice: effectiveSalePrice,
          preOrderPrice: effectivePreOrderPrice,
          productVariant: {
            id: selectedVar.id,
            name: selectedVar.name,
            price: selectedVar.priceWithTax || selectedVar.price || 0,
            stockLevel: selectedVar.stockLevel,
            product: { id: product.id, name: product.name, slug: product.slug },
            options: selectedVar.options || [],
            featuredAsset: selectedVar.featuredAsset || product.featuredAsset,
          },
        };

        await addToLocalCart(localCart, localCartItem);
        appState.showCart = true;
        loadCountryOnDemand(appState);

        // Screen reader announcement
        const announcement = document.createElement('div');
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.className = 'sr-only';
        announcement.textContent = `${product.name} added to cart`;
        document.body.appendChild(announcement);
        setTimeout(() => announcement.remove(), 3000);
      } catch (error) {
        console.error('Error adding item to local cart:', error);
        addItemToOrderErrorSignal.value = 'Failed to add item to cart';
      } finally {
        isAddingToCart.value = false;
      }
    }
  });

  // T12: PDP cart quantity init on boot + live update
  useOnDocument('qinit', $(() => {
    const variantIds = (product.variants || []).map((v: Variant) => v.id);
    quantitySignal.value = LocalCartService.getItemQuantitiesFromStorage(variantIds);
  }));
  useOnWindow('cart-updated', $(() => {
    const variantIds = (product.variants || []).map((v: Variant) => v.id);
    quantitySignal.value = LocalCartService.getItemQuantitiesFromStorage(variantIds);
  }));

  // Display price — updates as selections change
  const displayPrice = useComputed$(() => {
    if (selectedVariant.value) return selectedVariant.value.priceWithTax || selectedVariant.value.price || 0;
    if (selectedValues.value[0] && groups.value.length > 1) {
      const gName = groups.value[0].groupName;
      const sel = selectedValues.value[0];
      const matching = product.variants.filter((v: Variant) =>
        v.options?.find((o: any) => o.group?.name === gName && o.name === sel)
      );
      if (matching.length) return Math.min(...matching.map((v: Variant) => v.priceWithTax || v.price || 0));
    }
    return Math.min(...product.variants.map((v: Variant) => v.priceWithTax || v.price || 0));
  });

  const showFromPrefix = useComputed$(() => groups.value.length > 1 && !selectedVariant.value);

  // CTA state helpers
  // Selection incomplete — no variant resolved yet, or pre-order consent not given
  const ctaDisabled = useComputed$(() =>
    !selectedVariant.value || (isPreOrder.value && !preOrderConsent.value)
  );
  const ctaClass = useComputed$(() => {
    if (isOutOfStock.value && selectedVariant.value) return 'dd-cta-btn oos';
    if (ctaDisabled.value) return 'dd-cta-btn disabled';
    if (isPreOrder.value) return 'dd-cta-btn preorder';
    return 'dd-cta-btn ready';
  });

  // First unselected group index
  const _firstUnselected = useComputed$(() =>
    selectedValues.value.findIndex(v => !v)
  );

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div class="dd-pdp">

      {/* PDP styles loaded via useStyles$(PDP_STYLES) */}

      <div class="dd-layout">

        {/* ═══ LEFT COLUMN: images ═══ */}
        <div class="dd-left-col">

        {/* ═══ THUMB SIDEBAR — desktop only ═══ */}
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

        {/* ═══ DESKTOP GALLERY ═══ */}
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

        {/* ═══ MOBILE CAROUSEL ═══ */}
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

        {/* Mobile dot indicators */}
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

        {/* ═══ RIGHT: INFO + SELECTOR ═══ */}
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
                  {/* eslint-disable-next-line qwik/jsx-img */}
                  <img src="/sezzle-color.svg" alt="Sezzle" width="58" height="16" loading="lazy" style={{ display: 'inline', verticalAlign: 'middle', marginLeft: '3px' }} />
                </a>
              </div>
            );
          })()}
          <div class="dd-rule" />

          {/* ── VARIANT SELECTOR ── */}
          {groups.value.map((group, groupIdx) => {
            const isMulti = groups.value.length > 1;
            const isLocked = groupIdx > 0 && !selectedValues.value[groupIdx - 1];
            const available = isLocked
              ? new Set<string>()
              : availableForGroup(product.variants, groups.value, groupIdx, selectedValues.value);
            const chosenVal = selectedValues.value[groupIdx];

            // Render mode detection
            const isBladeGroup = isMulti && groupIdx === 0;
            const isColorGroup = /color|colour|handle/i.test(group.groupName);
            const isHandleGroup = isMulti && groupIdx > 0 && isColorGroup;
            const isColorSingle = !isMulti && isColorGroup;

            return (
              <div key={group.groupName} style={groupIdx > 0 ? { paddingTop: '28px' } : {}}>
                <div class={`dd-sel-group${isLocked ? ' locked' : ''}`}
                  style={isMulti && groupIdx > 0 && isLocked ? { display: 'none' } : isMulti && groupIdx > 0 ? { animation: 'dd-fadeIn 0.2s ease' } : {}}
                >
                  {/* Step label for all products */}
                  <div class="dd-sel-head">
                    <span class="dd-sel-label">0{groupIdx + 1} — {group.groupName}</span>
                    {chosenVal && <span class="dd-sel-chosen">{chosenVal}</span>}
                  </div>

                  {/* Blade style cards (group 0 of multi-group) */}
                  {isBladeGroup && (
                    <div class="dd-blade-grid" style={`grid-template-columns: repeat(${group.values.length}, 1fr)`}>
                      {group.values.map(val => {
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

                  {/* Swatches — group named Handle/Color (either multi or single) */}
                  {(isHandleGroup || isColorSingle) && (
                    <div class="dd-swatch-grid">
                      {group.values.map(val => {
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

                  {/* Pills — single-group non-color, or any unlabelled group */}
                  {!isBladeGroup && !isHandleGroup && !isColorSingle && (() => {
                    // Check if prices vary across variants
                    const prices = product.variants.map((v: Variant) => v.priceWithTax || v.price || 0);
                    const pricesVary = new Set(prices).size > 1;
                    return (
                    <div class="dd-pill-grid">
                      {group.values.map(val => {
                        const isAvail = available.has(val);
                        // Find variant matching this pill to get its price
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

          {/* ── Pre-order consent (visible on both mobile and desktop) ── */}
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

          {/* ── CTA — desktop ── */}
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

          {/* Trust bar */}
          <div class="dd-trust">
            <div class="dd-trust-item">
              <svg class="dd-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3-5h4l-1 5h5.5a2 2 0 0 1 1.6 3.2L13 18h-4"/><circle cx="7.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/><path d="M15 18h2.5"/></svg>
              <div class="dd-trust-text">
                <span class="dd-trust-val">Free</span>
                <span class="dd-trust-lbl">Ship over $100</span>
              </div>
            </div>
            <div class="dd-trust-item">
              <svg class="dd-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/><path d="M12 7v5l3 3"/></svg>
              <div class="dd-trust-text">
                <span class="dd-trust-val">1 week</span>
                <span class="dd-trust-lbl">Defect returns</span>
              </div>
            </div>
            <div class="dd-trust-item">
              <svg class="dd-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <div class="dd-trust-text">
                <span class="dd-trust-val">Secure</span>
                <span class="dd-trust-lbl">Checkout</span>
              </div>
            </div>
          </div>

          <div class="dd-rule" />

          {/* Description */}
          {product.description && (
            <div
              class="dd-desc"
              dangerouslySetInnerHTML={enhanceDescription(product.name, sanitizeProductDescription(product.description || ''))}
            />
          )}

          {/* Pre-order notice */}
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

      {/* ═══ MOBILE FIXED ATC BAR ═══ */}
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

      {/* ═══ IMAGE MODAL ═══ */}
      {showImageModal.value && (
        <div class="dd-modal"
          onClick$={e => { if (e.target === e.currentTarget) closeImageModal(); }}
        >
          <button class="dd-modal-close" onClick$={closeImageModal} aria-label="Close">×</button>
          <div class="dd-modal-inner">
            {isImageLoading.value && <div class="dd-img-loading"><div class="dd-spinner" /></div>}
            <OptimizedImage
              src={modalImageSrc.value}
              alt={`${product.name} enlarged view ${modalImageIndex.value + 1} of ${orderedAssets.value.length} - Premium knife detail from Damned Designs`}
              loading="eager"
              responsive="productMain"
              onClick$={e => e.stopPropagation()}
            />
          </div>
          {orderedAssets.value.length > 1 && (
            <>
              {modalImageIndex.value > 0 && (
                <button class="dd-modal-nav dd-modal-prev"
                  onClick$={e => { e.stopPropagation(); navigateModal('prev'); }}
                  aria-label="Previous image">
                  <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
                  </svg>
                </button>
              )}
              {modalImageIndex.value < orderedAssets.value.length - 1 && (
                <button class="dd-modal-nav dd-modal-next"
                  onClick$={e => { e.stopPropagation(); navigateModal('next'); }}
                  aria-label="Next image">
                  <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                  </svg>
                </button>
              )}
              <div class="dd-modal-counter">
                {modalImageIndex.value + 1} / {orderedAssets.value.length}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────
// Head — identical to original (preserves generateImagePreloadLinks for LCP)
// ─────────────────────────────────────────────────────────────────
export const head = ({ resolveValue, url: _url }: { resolveValue: any; url: URL }) => {
  const loaderResult = resolveValue(useProductLoader);
  const product = loaderResult?.product || loaderResult;

  const cleanDescription = product?.description
    ? (() => {
      const raw = product.description.replace(/<[^>]*>/g, '').replace(/[""]/g, '"').replace(/['']/g, "'").trim();
      if (raw.length <= 160) return raw;
      const truncated = raw.substring(0, 160);
      const lastSpace = truncated.lastIndexOf(' ');
      return (lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated).replace(/[.,;:!?\s]+$/, '') + '…';
    })()
    : `${product?.name || 'Product'} - High quality product available at Damned Designs`;

  let imagePreloadLinks: any[] = [];
  if (product?.featuredAsset?.preview) {
    imagePreloadLinks.push(
      ...generateImagePreloadLinks(product.featuredAsset.preview, 'productMain', ['avif', 'webp']),
    );
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: 'https://www.damneddesigns.com/' },
    { name: 'Shop', url: 'https://www.damneddesigns.com/shop' },
    { name: product?.name || 'Product', url: `https://www.damneddesigns.com/products/${product?.slug || ''}/` },
  ]);

  let productSchema = null;
  try {
    productSchema = generateProductSchema(product);
  } catch (error) {
    console.warn('Failed to generate product schema:', error);
  }

  const schemas: JsonLdSchema[] = [breadcrumbSchema];
  if (productSchema) schemas.push(productSchema);

  const canonicalUrl = `https://www.damneddesigns.com/products/${product?.slug || ''}/`;
  return createSEOHead({
    title: product?.name || 'Product',
    description: cleanDescription || `${product?.name || 'Product'} - Premium quality knife from Damned Designs`,
    image: product?.featuredAsset?.preview,
    canonical: canonicalUrl,
    ogUrl: canonicalUrl,
    ogType: 'product',
    links: imagePreloadLinks,
    schemas,
  });
};

// ─────────────────────────────────────────────────────────────────
// Static generation — identical to original
// ─────────────────────────────────────────────────────────────────
import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = async () => {
  const endpoint = process.env.VENDURE_API_URL || 'http://localhost:3100/shop-api';
  const query = `
    query GetProductSlugs {
      products(options: { take: 500 }) {
        items { slug }
      }
    }
  `;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = await response.json();
    const slugs: string[] = json?.data?.products?.items?.map((p: { slug: string }) => p.slug) ?? [];
    return { params: slugs.map(slug => ({ slug })) };
  } catch (error) {
    console.error('Failed to generate product slugs', error);
    return { params: [] };
  }
};