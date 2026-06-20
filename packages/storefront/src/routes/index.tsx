// Homepage - Refined editorial design
import { component$, useStyles$, useSignal, useContext, $ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';
import { generateOrganizationSchema, generateWebsiteSchema } from '~/services/seo-api.service';
import VerificationButton from '~/components/verification/VerificationButton';
import { routeLoader$ } from '@qwik.dev/router';
import { APP_STATE } from '~/constants';
import { type LocalCartItem } from '~/services/LocalCartService';
import { useLocalCart, addToLocalCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { getProductBySlug } from '~/providers/shop/products/products';

// Responsive hero images with multi-format support
// Hero (LCP) — 75: sharp enough for knife detail at this size, saves ~45KB vs q85
import HeroImage_768 from '~/media/hero.jpg?format=avif&w=768&quality=75&url';
import HeroImage_1024 from '~/media/hero.jpg?format=avif&w=1024&quality=75&url';
import HeroImage_1600 from '~/media/hero.jpg?format=avif&w=1600&quality=75&url';
import HeroImageWebP_768 from '~/media/hero.jpg?format=webp&w=768&quality=80&url';
import HeroImageWebP_1024 from '~/media/hero.jpg?format=webp&w=1024&quality=80&url';
import HeroImageWebP_1600 from '~/media/hero.jpg?format=webp&w=1600&quality=80&url';
import HeroImageJPEG_768 from '~/media/hero.jpg?format=jpeg&w=768&quality=90&url';
import HeroImageJPEG_1024 from '~/media/hero.jpg?format=jpeg&w=1024&quality=90&url';
import HeroImageJPEG_1600 from '~/media/hero.jpg?format=jpeg&w=1600&quality=90&url';

// Pre-order section image — 65: decorative/lifestyle, not a purchase decision image
import PreorderImage_480 from '~/media/sec2.jpg?format=avif&w=480&quality=65&url';
import PreorderImage_768 from '~/media/sec2.jpg?format=avif&w=768&quality=65&url';
import PreorderImage_1024 from '~/media/sec2.jpg?format=avif&w=1024&quality=65&url';
import PreorderImageWebP_480 from '~/media/sec2.jpg?format=webp&w=480&quality=70&url';
import PreorderImageWebP_768 from '~/media/sec2.jpg?format=webp&w=768&quality=70&url';
import PreorderImageWebP_1024 from '~/media/sec2.jpg?format=webp&w=1024&quality=70&url';
import PreorderImageJPEG_1024 from '~/media/sec2.jpg?format=jpeg&w=1024&quality=80&url';

// Tee section image — 65: decorative/lifestyle section, not a purchase decision image
import TeeImage_480 from '~/media/homelast.png?format=avif&w=480&quality=65&url';
import TeeImage_768 from '~/media/homelast.png?format=avif&w=768&quality=65&url';
import TeeImage_1024 from '~/media/homelast.png?format=avif&w=1024&quality=65&url';
import TeeImageWebP_480 from '~/media/homelast.png?format=webp&w=480&quality=70&url';
import TeeImageWebP_768 from '~/media/homelast.png?format=webp&w=768&quality=70&url';
import TeeImageWebP_1024 from '~/media/homelast.png?format=webp&w=1024&quality=70&url';
import TeeImageJPEG_1024 from '~/media/homelast.png?format=jpeg&w=1024&quality=80&url';

/* ── Trustpilot data — reads local JSON file at runtime (updated by cron every 6 hours) ── */
const TP_FALLBACK = {
  score: '4.7',
  count: '298+',
  reviews: [
    { text: '"Absolutely amazing company with phenomenal customer service, fast shipping, and out of this world designs and products."', name: 'Jonathan Rivera' },
    { text: '"Quick shipping to the UK. Great quality knife. The Cerberus is great for gardening and food prep."', name: 'Modge' },
    { text: '"Great lil knives! Comfy and compact designs with great front flipper action. Shipping was quick."', name: 'Michael Sharp' },
    { text: '"Excellent quality and fast delivery. The knife arrived well packaged and looks even better in person."', name: 'David W.' },
    { text: '"Best EDC gear out there. Incredible build quality and the designs are absolutely unique."', name: 'Chris M.' },
    { text: '"Outstanding products. Already bought three items and will definitely be ordering again."', name: 'Taylor R.' },
  ],
};

// In-memory cache — loaded once on first request, auto-refreshes when cron updates file
let _tpCache: any = null;
let _tpWatching = false;

async function getTrustpilotData() {
  if (_tpCache) return _tpCache;
  try {
    const { readFileSync, watch } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const filePath = join(dir, '..', '..', 'src', 'data', 'trustpilot.json');
    _tpCache = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Watch for changes — re-read only when cron updates the file
    if (!_tpWatching) {
      _tpWatching = true;
      try {
        watch(filePath, () => {
          try { _tpCache = JSON.parse(readFileSync(filePath, 'utf-8')); }
          catch { /* keep existing cache */ }
        });
      } catch { /* fs.watch not available */ }
    }

    return _tpCache;
  } catch {
    return TP_FALLBACK;
  }
}

export const useTrustpilotData = routeLoader$(async () => {
  return getTrustpilotData();
});

/* ── Pre-order product data — fetched at SSR time ── */
export const usePreorderProduct = routeLoader$(async () => {
  try {
    const product = await getProductBySlug('pocket-fixed-blade');
    if (!product) return null;
    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      featuredAsset: product.featuredAsset,
      variants: product.variants.map((v: any) => ({
        id: v.id,
        name: v.name,
        price: v.price,
        priceWithTax: v.priceWithTax,
        stockLevel: v.stockLevel,
        options: v.options,
        featuredAsset: v.featuredAsset,
        customFields: {
          preOrderPrice: v.customFields?.preOrderPrice,
          salePrice: v.customFields?.salePrice,
          shipDate: v.customFields?.shipDate,
          isPreOrder: v.customFields?.isPreOrder,
        },
      })),
    };
  } catch {
    return null;
  }
});

const STYLES = `
  /* ── Color palette ── */
  .hp { --accent: #965341; --accent-light: #B06B56; --accent-glow: rgba(150,83,65,0.35); --accent-dim: rgba(150,83,65,0.12); --dark: #0A0A0A; --dark-elevated: #111110; --dark-surface: #1A1A1A; --dark-border: #2A2A28; --parchment: #F7F2EA; --parchment-deep: #EDE7DC; --warm-grey: #706860; --off-white: #F5F0E8; --text-on-dark: #E8E2D8; --text-on-dark-secondary: #9A9488; --text-on-light: #1A1A1A; --text-on-light-secondary: #5A5650; }

  /* ── Hero image ── */
  .hero-img { image-rendering: auto; }

  /* ── Hero ── */
  .hero { position: relative; width: 100%; height: 100svh; min-height: 560px; overflow: hidden; display: flex; align-items: flex-end; }
  @supports not (height: 100svh) { .hero { height: 100vh; } }
  .hero-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse 70% 60% at 50% 50%, transparent 0%, rgba(0,0,0,0.25) 100%), linear-gradient(to right, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 30%, transparent 55%), linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, transparent 25%, transparent 60%, rgba(0,0,0,0.65) 100%); z-index: 2; }
  .hero-content { position: relative; z-index: 10; width: 100%; padding: 0 1.5rem 3rem; display: flex; flex-direction: column; gap: 2rem; }
  @media (min-width: 1024px) { .hero-content { padding: 0 3.25rem 3.75rem; flex-direction: row; align-items: flex-end; justify-content: space-between; } }

  .hero-kicker { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .hero-kicker-dot { width: 8px; height: 8px; border-radius: 50%; background: #22C55E; flex-shrink: 0; }
  .hero-kicker-text { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent-light); }
  .hero-title { font-family: var(--font-display); font-weight: 700; font-size: var(--step-4); line-height: 1.05; color: #fff; letter-spacing: -1px; margin-bottom: 10px; }
  .hero-title em { font-style: italic; color: var(--accent-light); }
  .hero-sub { font-family: var(--font-body); font-size: var(--step-0); color: rgba(255,255,255,0.65); letter-spacing: 0.2px; margin-bottom: 28px; max-width: 360px; line-height: 1.7; text-wrap: pretty; }
  .hero-ctas { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }

  .hero-meta { text-align: right; display: none; flex-direction: column; gap: 10px; }
  @media (min-width: 1024px) { .hero-meta { display: flex; } }
  .meta-val { font-family: var(--font-display); font-size: 26px; font-weight: 700; color: #fff; line-height: 1; }
  .meta-label { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2.5px; text-transform: uppercase; color: rgba(255,255,255,0.55); }

  /* ── Scroll hint ── */
  .scroll-hint { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 10; opacity: 0.7; }

  /* ── Buttons ── */
  .btn-primary { display: inline-flex; align-items: center; gap: 10px; background: var(--accent); color: #fff; border: none; padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: background 0.2s, transform 0.15s; text-decoration: none; width: auto; }
  .btn-primary:hover { background: var(--accent-light); }
  .btn-primary:active { transform: scale(0.96); }
  .btn-ghost { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: var(--off-white); border: 1px solid rgba(245,240,232,0.25); padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: border-color 0.2s, color 0.2s, transform 0.15s; text-decoration: none; width: auto; }
  .btn-ghost:hover { border-color: rgba(245,240,232,0.5); color: #fff; }
  .btn-ghost:active { transform: scale(0.96); }
  .btn-primary--dark { display: inline-flex; align-items: center; gap: 10px; background: var(--dark-surface); color: var(--off-white); border: none; padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: background 0.2s, transform 0.15s; text-decoration: none; }
  .btn-primary--dark:hover { background: var(--dark-border); }
  .btn-primary--dark:active { transform: scale(0.96); }
  .btn-ghost--dark { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: var(--text-on-light); border: 1px solid rgba(26,26,26,0.2); padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: border-color 0.2s, color 0.2s, transform 0.15s; text-decoration: none; }
  .btn-ghost--dark:hover { border-color: var(--text-on-light); }
  .btn-ghost--dark:active { transform: scale(0.96); }
  .btn-arrow { display: inline-block; transition: transform 0.3s ease; }
  .btn-primary:hover .btn-arrow, .btn-primary--dark:hover .btn-arrow { transform: translateX(4px); }

  /* ── Trust bar (scrolling ticker) ── */
  .trust-bar { background: var(--dark); overflow: hidden; position: relative; padding: 16px 0; white-space: nowrap; }
  .trust-track { display: inline-flex; gap: 0; animation: hp-ticker 30s linear infinite; white-space: nowrap; }
  .trust-item { display: flex; align-items: center; gap: 10px; padding: 0 32px; white-space: nowrap; }
  .trust-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .trust-text { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-on-dark-secondary); }

  /* ── Reveal system ── */
  .reveal { opacity: 0; transform: translateY(28px); transition: opacity 0.7s cubic-bezier(0.23,1,0.32,1), transform 0.7s cubic-bezier(0.23,1,0.32,1); }
  .reveal.visible { opacity: 1; transform: translateY(0); }
  .reveal-d1 { transition-delay: 0.1s; }
  .reveal-d2 { transition-delay: 0.2s; }
  .reveal-d3 { transition-delay: 0.3s; }
  .reveal-d4 { transition-delay: 0.4s; }
  @media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; transform: none; transition: none; } }

  /* ── Hero text (no stagger — instant paint) ── */
  .stagger-1, .stagger-2, .stagger-3, .stagger-4 { opacity: 1; }

  /* ── Pre-order section ── */
  .preorder { background: var(--parchment); padding: 3rem 1.5rem; display: grid; grid-template-columns: 1fr; gap: 3rem; align-items: center; }
  @media (min-width: 1024px) { .preorder { padding: 5.5rem 3.25rem; grid-template-columns: 1fr 1fr; gap: 5rem; } }
  .po-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--dark); color: var(--accent-light); padding: 6px 14px; font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2.5px; text-transform: uppercase; margin-bottom: 24px; border-radius: 2px; }
  .po-dot-green { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; animation: hp-pulse-dot 1.8s ease-in-out infinite; }
  .po-label { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin-bottom: 12px; }
  .po-title { font-family: var(--font-display); font-weight: 700; font-size: var(--step-3); line-height: 0.95; color: var(--text-on-light); letter-spacing: -0.5px; margin-bottom: 12px; text-wrap: balance; }
  .po-specs { font-family: var(--font-body); font-size: 0.8125rem; letter-spacing: 1px; color: var(--warm-grey); margin-bottom: 16px; }
  .po-sub { font-family: var(--font-body); font-size: var(--step-0); color: var(--text-on-light-secondary); line-height: 1.8; max-width: 400px; margin-bottom: 32px; text-wrap: pretty; }

  .po-selector-label { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2px; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 10px; }
  .po-styles { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .po-style-btn { background: var(--parchment-deep); color: var(--text-on-light); border: 1px solid transparent; padding: 10px 20px; cursor: pointer; font-family: var(--font-body); font-size: 0.8125rem; letter-spacing: 1.5px; text-transform: uppercase; transition: border-color 0.2s, background 0.2s, color 0.2s, transform 0.15s; border-radius: 2px; }
  .po-style-btn:active { transform: scale(0.96); }
  .po-style-btn:hover { border-color: var(--accent); }
  .po-style-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  .po-colors { display: flex; gap: 12px; margin-bottom: 28px; }
  .po-color-swatch { width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s; position: relative; }
  .po-color-swatch:hover { border-color: var(--accent-light); }
  .po-color-swatch.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--parchment), 0 0 0 4px var(--accent); }
  .po-color-swatch::after { content: ''; position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); font-family: var(--font-body); font-size: 0.625rem; letter-spacing: 1px; text-transform: uppercase; color: var(--warm-grey); white-space: nowrap; }
  .po-color-black { background: #1a1a1a; }
  .po-color-white { background: #f5f0e8; border-color: #ddd; }
  .po-color-white.active { border-color: var(--accent); }
  .po-color-jade { background: #6b8f71; }

  .po-price { font-family: var(--font-display); font-size: 1.75rem; font-weight: 700; color: var(--text-on-light); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
  .po-price-note { font-family: var(--font-mono); font-size: 0.75rem; color: var(--warm-grey); letter-spacing: 0.5px; margin-bottom: 24px; }
  .po-actions { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }

  .po-img-wrap { position: relative; overflow: hidden; border-radius: 2px; }
  .po-img { width: 100%; height: auto; aspect-ratio: 4/5; object-fit: cover; display: block; transition: transform 0.6s cubic-bezier(0.25,0.1,0.25,1); outline: 1px solid rgba(0,0,0,0.06); outline-offset: -1px; }
  .po-img-wrap:hover .po-img { transform: scale(1.03); }
  @media (max-width: 1023px) { .preorder-img-cell { order: -1; } }

  /* ── Tee section ── */
  .tee { position: relative; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='250'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='250' height='250' filter='url(%23n)' opacity='0.12'/%3E%3C/svg%3E"), linear-gradient(to bottom, #0a0a09, #181614); background-size: 250px 250px, 100% 100%; padding: 3rem 1.5rem; display: grid; grid-template-columns: 1fr; gap: 3rem; align-items: center; }
  @media (min-width: 1024px) { .tee { padding: 5.5rem 3.25rem; grid-template-columns: 1fr 1fr; gap: 5rem; } }
  .tee-img-wrap { position: relative; overflow: hidden; border-radius: 2px; }
  .tee-img { width: 100%; height: auto; aspect-ratio: 1/1; object-fit: cover; display: block; background: var(--dark-elevated); transition: transform 0.6s cubic-bezier(0.25,0.1,0.25,1); outline: 1px solid rgba(255,255,255,0.06); outline-offset: -1px; }
  .tee-img-wrap:hover .tee-img { transform: scale(1.03); }
  .tee-tag { position: absolute; top: 16px; left: 16px; background: var(--accent); color: #fff; padding: 6px 14px; font-family: var(--font-body); font-size: 0.6875rem; letter-spacing: 2px; text-transform: uppercase; border-radius: 2px; z-index: 2; }
  .tee-label { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent-light); margin-bottom: 12px; }
  .tee-title { font-family: var(--font-display); font-weight: 700; font-size: var(--step-3); line-height: 0.95; color: var(--text-on-dark); letter-spacing: -0.5px; margin-bottom: 16px; text-wrap: balance; }
  .tee-title em { font-style: italic; color: var(--accent-light); }
  .tee-body { font-family: var(--font-body); font-size: var(--step-0); color: var(--text-on-dark-secondary); line-height: 1.8; max-width: 400px; margin-bottom: 20px; text-wrap: pretty; }
  .tee-spec { padding: 14px 0; border-bottom: 1px solid var(--dark-border); display: flex; justify-content: space-between; }
  .tee-spec:first-child { border-top: 1px solid var(--dark-border); }
  .tee-spec-k { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2px; text-transform: uppercase; color: var(--text-on-dark-secondary); }
  .tee-spec-v { font-family: var(--font-display); font-size: 0.875rem; color: var(--text-on-dark); }
  .tee-price { font-family: var(--font-display); font-size: 1.5rem; font-weight: 700; color: var(--text-on-dark); margin-top: 20px; margin-bottom: 24px; font-variant-numeric: tabular-nums; }

  /* ── Reviews ── */
  .reviews { background: var(--parchment); padding: 3rem 1.5rem; }
  @media (min-width: 1024px) { .reviews { padding: 5rem 3.25rem; } }
  .reviews-header { text-align: center; margin-bottom: 3rem; }
  .reviews-score { font-family: var(--font-display); font-size: 4rem; font-weight: 700; color: var(--text-on-light); line-height: 1; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  .reviews-tp-stars { display: flex; align-items: center; justify-content: center; gap: 4px; margin-bottom: 8px; }
  .reviews-tp-star { width: 20px; height: 20px; background: #00B67A; display: flex; align-items: center; justify-content: center; }
  .reviews-count { font-family: var(--font-mono); font-size: 0.8125rem; letter-spacing: 1.5px; color: var(--warm-grey); margin-bottom: 4px; }
  .reviews-label { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 3px; text-transform: uppercase; color: var(--accent); }
  .reviews-grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
  @media (min-width: 640px) { .reviews-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 1024px) { .reviews-grid { grid-template-columns: repeat(3, 1fr); } }
  .rev-card { background: #fff; padding: 28px 24px; border-radius: 2px; border: 1px solid var(--parchment-deep); transition: transform 0.3s cubic-bezier(0.22,0.61,0.36,1), box-shadow 0.3s cubic-bezier(0.22,0.61,0.36,1); }
  .rev-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
  .rev-stars { display: flex; gap: 3px; margin-bottom: 16px; }
  .rev-star { width: 12px; height: 12px; background: var(--accent); clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%); }
  .rev-text { font-family: var(--font-body); font-size: var(--step-0); color: var(--text-on-light); line-height: 1.7; margin-bottom: 20px; text-wrap: pretty; }
  .rev-author { display: flex; align-items: center; gap: 12px; }
  .rev-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-family: var(--font-body); font-size: 0.8125rem; font-weight: 600; }
  .rev-name { font-family: var(--font-body); font-size: 0.8125rem; font-weight: 500; color: var(--text-on-light); letter-spacing: 0.5px; }
  .rev-verified { font-family: var(--font-mono); font-size: 0.6875rem; color: var(--warm-grey); letter-spacing: 0.5px; }

  /* ── Service strip ── */
  .service { background: var(--parchment); padding: 2rem 1.5rem; }
  @media (min-width: 768px) { .service { padding: 2.5rem 3.25rem; } }
  .service-card { background: #1B2A4A; border-radius: 4px; padding: 3rem 2rem; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .service-title { font-family: var(--font-display); font-weight: 700; font-size: 1.5rem; color: #fff; text-wrap: balance; }
  .service-desc { font-family: var(--font-body); font-size: 0.875rem; color: rgba(255,255,255,0.7); max-width: 400px; line-height: 1.6; }
  .service-btn { display: inline-flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 12px 28px; cursor: pointer; min-height: 44px; font-family: var(--font-body); font-weight: 500; font-size: 0.8125rem; letter-spacing: 1px; text-transform: uppercase; border-radius: 2px; transition: background 0.2s, border-color 0.2s, transform 0.15s; text-decoration: none; }
  .service-btn:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.4); }
  .service-btn:active { transform: scale(0.96); }

  /* ── Newsletter ── */
  .newsletter { background: var(--dark-elevated); padding: 4rem 1.5rem; text-align: center; }
  @media (min-width: 768px) { .newsletter { padding: 5rem 3.25rem; } }
  .nl-label { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent-light); margin-bottom: 12px; }
  .nl-title { font-family: var(--font-display); font-weight: 700; font-size: clamp(1.75rem, 3vw, 2.25rem); color: var(--text-on-dark); margin-bottom: 8px; text-wrap: balance; }
  .nl-sub { font-family: var(--font-body); font-size: 0.875rem; color: var(--text-on-dark-secondary); margin-bottom: 28px; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.6; }
  .nl-form { display: flex; gap: 0; max-width: 420px; margin: 0 auto; }
  .nl-input { flex: 1; background: var(--dark-surface); border: 1px solid var(--dark-border); border-right: none; color: var(--text-on-dark); padding: 14px 16px; font-family: var(--font-body); font-size: 0.875rem; border-radius: 2px 0 0 2px; outline: none; }
  .nl-input::placeholder { color: var(--text-on-dark-secondary); }
  .nl-input:focus { border-color: var(--accent); }
  .nl-submit { background: var(--accent); color: #fff; border: none; padding: 14px 24px; cursor: pointer; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 0 2px 2px 0; transition: background 0.2s, transform 0.15s; white-space: nowrap; }
  .nl-submit:hover { background: var(--accent-light); }
  .nl-submit:active { transform: scale(0.96); }

  /* ── Skeleton ── */
  @keyframes skel-shimmer { 0% { background-position: -468px 0; } 100% { background-position: 468px 0; } }
  .skeleton { background: linear-gradient(90deg, #f0ebe4 25%, #e8e0d5 37%, #f0ebe4 63%); background-size: 936px 100%; animation: skel-shimmer 1.6s ease-in-out infinite; border-radius: 4px; }

  /* ── Product image hover ── */
  .po-img, .tee-img { transition: transform 0.6s cubic-bezier(0.25,0.1,0.25,1); }
` as const;

const TRUST_SIGNALS = [
  'Free shipping over $100',
  'Lifetime defect warranty',
  'Pay in 4 with Sezzle',
  'Ships within 2 business days',
] as const;

const BLADE_STYLES = ['Yokai', 'Basilisk', 'Fenrir'] as const;
const COLOR_OPTIONS = [
  { name: 'Black', cls: 'po-color-black' },
  { name: 'White', cls: 'po-color-white' },
  { name: 'Jade G10', cls: 'po-color-jade' },
] as const;

const TEE_SPECS = [
  { k: 'Material', v: '280gsm, 50% cotton, 45% polyester, 5% lycra' },
  { k: 'Fit', v: 'Relaxed / oversized' },
  { k: 'Print', v: 'High density + puff screen print' },
] as const;

const ReviewStars = component$<{ color?: string }>(({ color }) => (
  <div class="rev-stars">
    {[...Array(5)].map((_, i) => <div key={i} class="rev-star" style={color ? { background: color } : undefined} />)}
  </div>
));

export default component$(() => {
  useStyles$(STYLES);

  const appState = useContext(APP_STATE);
  const localCart = useLocalCart();
  const tpData = useTrustpilotData();
  const preorderProduct = usePreorderProduct();
  const activeBlade = useSignal(0);
  const activeColor = useSignal(0);
  const isAddingToCart = useSignal(false);

  const nlEmail = useSignal('');
  const nlHoneypot = useSignal('');
  const nlState = useSignal<'idle' | 'sending' | 'success' | 'error'>('idle');
  const nlError = useSignal('');

  const handleNewsletterSubmit = $(async () => {
    if (nlState.value === 'sending') return;
    const email = nlEmail.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nlError.value = 'Please enter a valid email.';
      nlState.value = 'error';
      return;
    }
    nlState.value = 'sending';
    nlError.value = '';
    try {
      const res = await fetch('/newsletter-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          honeypot: nlHoneypot.value,
        }),
      });
      if (!res.ok) {
        const msg = res.status === 429 ? 'Too many signups from this IP. Try again in an hour.' : 'Subscription failed. Please try again.';
        nlError.value = msg;
        nlState.value = 'error';
        return;
      }
      nlState.value = 'success';
      nlEmail.value = '';
    } catch {
      nlError.value = 'Network error. Please try again.';
      nlState.value = 'error';
    }
  });

  const handlePreorderAddToCart = $(async () => {
    const product = preorderProduct.value;
    if (!product || isAddingToCart.value) return;

    isAddingToCart.value = true;
    try {
      const bladeName = BLADE_STYLES[activeBlade.value];
      const colorName = COLOR_OPTIONS[activeColor.value].name;
      // Map display color name to variant option name
      const handleMap: Record<string, string> = { 'Black': 'Black G10', 'White': 'White G10', 'Jade G10': 'Jade G10' };
      const handleName = handleMap[colorName] || colorName;

      // Find matching variant
      const variant = product.variants.find((v: any) =>
        v.options.some((o: any) => o.group?.name === 'Blade' && o.name === bladeName) &&
        v.options.some((o: any) => o.group?.name === 'Handle' && o.name === handleName)
      );

      if (!variant) {
        console.error('No variant found for', bladeName, handleName);
        isAddingToCart.value = false;
        return;
      }

      const localCartItem: LocalCartItem = {
        productVariantId: variant.id,
        quantity: 1,
        isPreOrder: true,
        shipDate: variant.customFields?.shipDate,
        preOrderPrice: variant.customFields?.preOrderPrice,
        productVariant: {
          id: variant.id,
          name: variant.name,
          price: variant.priceWithTax || variant.price || 0,
          stockLevel: variant.stockLevel,
          product: { id: product.id, name: product.name, slug: product.slug },
          options: variant.options || [],
          featuredAsset: variant.featuredAsset || product.featuredAsset,
        },
      };

      // Cart add via the context helper — respects the LocalCart vs ServerCart
      // strangler flag and dispatches the header-badge update itself.
      await addToLocalCart(localCart, localCartItem);
      localCart.hasLoadedOnce = true;
      appState.showCart = true;
      loadCountryOnDemand(appState);

      isAddingToCart.value = false;
    } catch (error) {
      console.error('Error adding pre-order to cart:', error);
      isAddingToCart.value = false;
    }
  });


  // T10: Scroll reveal via CSS animation-timeline (no UVT needed)
  // Elements with [data-reveal] animate via @keyframes hp-fade-reveal in global.css

  return (
    <div class="hp">
      {/* ════════ Hero ════════ */}
      <section class="hero">
        <div class="absolute inset-0">
          <picture>
            <source type="image/avif"
              srcset={`${HeroImage_768} 768w, ${HeroImage_1024} 1024w, ${HeroImage_1600} 1600w`}
              sizes="(max-width: 768px) 100vw, (max-width: 1440px) 1024px, 1600px" />
            <source type="image/webp"
              srcset={`${HeroImageWebP_768} 768w, ${HeroImageWebP_1024} 1024w, ${HeroImageWebP_1600} 1600w`}
              sizes="(max-width: 768px) 100vw, (max-width: 1440px) 1024px, 1600px" />
            <source type="image/jpeg"
              srcset={`${HeroImageJPEG_768} 768w, ${HeroImageJPEG_1024} 1024w, ${HeroImageJPEG_1600} 1600w`}
              sizes="(max-width: 768px) 100vw, (max-width: 1440px) 1024px, 1600px" />
            <img
              src={HeroImageJPEG_1024}
              alt="Premium EDC folding knife with precision craftsmanship - Damned Designs"
              loading="eager" fetchPriority="high" decoding="sync"
              width={1600} height={1067}
              class="hero-img absolute inset-0 w-full h-full object-cover"
              style="object-position: center 40%"
            />
          </picture>
          <div class="hero-overlay" />
        </div>

        <div class="scroll-hint" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>

        <div class="hero-content">
          <div style="text-shadow: 0 1px 20px rgba(0,0,0,0.4)">
            <h1 class="hero-title">
              <span class="hero-kicker-text" style="display:block;margin-bottom:16px">EDC Knives &middot; Fidgets &middot; Gear</span>
              Built to be<br /><em>carried.</em><br />Not collected.
            </h1>
            <div class="hero-kicker stagger-2" style="margin-top:16px">
              <span class="hero-kicker-dot" style="width:8px;height:8px;border-radius:50%;background:#22C55E;position:relative;display:inline-block" />
              <span class="hero-kicker-text">Pocket Fixed Blade &mdash; From $40 &mdash; Pre-Order Now</span>
            </div>
            <p class="hero-sub stagger-3">14C28N stainless steel. G10 handles. Kydex sheath. Find another at this price &mdash; we'll wait.</p>
            <div class="hero-ctas stagger-4">
              <a href="/products/pocket-fixed-blade" class="btn-primary">Shop Now <span class="btn-arrow">&rarr;</span></a>
              <a href="/shop" class="btn-ghost">See the Lineup</a>
            </div>
          </div>

          <div class="hero-meta stagger-4" style="text-shadow: 0 1px 16px rgba(0,0,0,0.5)">
            <a href="https://www.trustpilot.com/review/damneddesigns.com" target="_blank" rel="noopener noreferrer" style="text-align:right;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,.18);display:block;text-decoration:none" aria-label="Trustpilot reviews">
              <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:5px">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#00B67A"><path d="M12 2l2.9 6.26L22 9.27l-5.5 5.01L17.82 22 12 18.77 6.18 22l1.32-7.72L2 9.27l7.1-1.01L12 2z"/></svg>
                <div style="display:flex;gap:2px">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} style="width:14px;height:14px;background:#00b67a;display:flex;align-items:center;justify-content:center">
                      <svg width="9" height="9" viewBox="0 0 10 10"><path d="M5 0l1.2 3.8H10L6.9 6.2l1.2 3.8L5 7.6 1.9 10l1.2-3.8L0 3.8h3.8z" fill="white"/></svg>
                    </div>
                  ))}
                </div>
                <span style="font-size:0.75rem;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,.65)">Trustpilot</span>
              </div>
              <div style="font-size:0.75rem;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.55)">{tpData.value.score} &middot; {tpData.value.count} reviews</div>
            </a>
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="meta-val">7+</span><span class="meta-label">Years making EDC</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="meta-val">Free</span><span class="meta-label">Shipping over $100</span>
            </div>
          </div>
        </div>
      </section>

      {/* ════════ Trust Bar (scrolling ticker) ════════ */}
      <div class="trust-bar" aria-label="Trust signals">
        <div class="trust-track" style="display:inline-flex;white-space:nowrap;animation:hp-ticker 30s linear infinite">
          {[...TRUST_SIGNALS, ...TRUST_SIGNALS, ...TRUST_SIGNALS].map((item, i) => (
            <div key={`${item}-${i}`} class="trust-item">
              <span class="trust-dot" />
              <span class="trust-text">{item}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ════════ Pre-order section ════════ */}
      <section class="preorder">
            <div>
              <div class="po-badge reveal visible"><span class="po-dot-green" />Now Taking Pre-Orders</div>
              <h2 class="po-title reveal visible" data-reveal>Pocket Fixed Blades</h2>
              <div class="po-specs reveal visible" data-reveal>3 Styles &middot; 3 Colors &middot; $40</div>
              <p class="po-sub reveal visible" data-reveal>
                Seven years of EDC obsession distilled into one carry. Three blade characters &mdash;
                Yokai, Basilisk, Fenrir &mdash; each available in Black, White, or Jade G10.
              </p>

              <div class="po-selector-label">Blade Style</div>
              <div class="po-styles" role="radiogroup" aria-label="Blade style selector">
                {BLADE_STYLES.map((name, i) => (
                  <button
                    key={name}
                    data-index={String(i)}
                    class={`po-style-btn ${activeBlade.value === i ? 'active' : ''}`}
                    onClick$={(e) => {
                      const el = (e.target as HTMLElement).closest('[data-index]') as HTMLElement | null;
                      if (el?.dataset.index) activeBlade.value = Number(el.dataset.index);
                    }}
                    role="radio"
                    aria-checked={activeBlade.value === i}
                  >{name}</button>
                ))}
              </div>

              <div class="po-selector-label">Color</div>
              <div class="po-colors" role="radiogroup" aria-label="Color selector">
                {COLOR_OPTIONS.map((c, i) => (
                  <button
                    key={c.name}
                    data-index={String(i)}
                    class={`po-color-swatch ${c.cls} ${activeColor.value === i ? 'active' : ''}`}
                    onClick$={(e) => {
                      const el = (e.target as HTMLElement).closest('[data-index]') as HTMLElement | null;
                      if (el?.dataset.index) activeColor.value = Number(el.dataset.index);
                    }}
                    role="radio"
                    aria-checked={activeColor.value === i}
                    aria-label={c.name}
                    title={c.name}
                  />
                ))}
              </div>

              <div class="po-price">$40 USD</div>

              <div class="po-actions">
                <button
                  class="btn-primary"
                  onClick$={handlePreorderAddToCart}
                  disabled={isAddingToCart.value}
                  aria-label={`Add to Cart – ${BLADE_STYLES[activeBlade.value]} ${COLOR_OPTIONS[activeColor.value].name}`}
                >
                  {isAddingToCart.value ? 'Adding...' : 'Add to Cart'} <span class="btn-arrow">&rarr;</span>
                </button>
                <a href="/products/pocket-fixed-blade" class="btn-ghost--dark">View Details</a>
              </div>
            </div>
            <div class="preorder-img-cell">
              <div class="po-img-wrap">
                <picture>
                  <source type="image/avif" srcset={`${PreorderImage_480} 480w, ${PreorderImage_768} 768w, ${PreorderImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                  <source type="image/webp" srcset={`${PreorderImageWebP_480} 480w, ${PreorderImageWebP_768} 768w, ${PreorderImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                  <img src={PreorderImageJPEG_1024} alt="Pocket Fixed Blade lineup - 3 styles, 3 colorways"
                    loading="lazy" decoding="async" width={1024} height={1280} class="po-img" />
                </picture>
              </div>
            </div>
      </section>

      {/* ════════ The Tee section ════════ */}
      <section class="tee">
            <div class="tee-img-wrap">
              <span class="tee-tag">New Drop</span>
              <picture>
                <source type="image/avif" srcset={`${TeeImage_480} 480w, ${TeeImage_768} 768w, ${TeeImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                <source type="image/webp" srcset={`${TeeImageWebP_480} 480w, ${TeeImageWebP_768} 768w, ${TeeImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                <img src={TeeImageJPEG_1024} alt="Damned Designs heavyweight tee - premium EDC apparel"
                  loading="lazy" decoding="async" width={1024} height={1024} class="tee-img" />
              </picture>
            </div>
            <div>
              <div class="tee-label" data-reveal>Apparel</div>
              <h2 class="tee-title" data-reveal>The Damned <em>Tee.</em></h2>
              <p class="tee-body" data-reveal>
                The same obsessive attention we put into our blades, applied to what you wear.
                Premium fabric. Considered fit. One design that says everything.
              </p>
              <div>
                {TEE_SPECS.map((s) => (
                  <div key={s.k} class="tee-spec">
                    <span class="tee-spec-k">{s.k}</span>
                    <span class="tee-spec-v">{s.v}</span>
                  </div>
                ))}
              </div>
              <div class="tee-price">$30</div>
              <a href="/products/t-shirt-mascot" class="btn-primary">Shop the Tee <span class="btn-arrow">&rarr;</span></a>
            </div>
      </section>

      {/* ════════ Reviews ════════ */}
      <section class="reviews">
            <div class="reviews-header" data-reveal>
              <div class="reviews-score">{tpData.value.score}</div>
              <div class="reviews-tp-stars">
                {[...Array(5)].map((_, i) => (
                  <div key={i} class="reviews-tp-star">
                    <svg width="12" height="12" viewBox="0 0 10 10"><path d="M5 0l1.2 3.8H10L6.9 6.2l1.2 3.8L5 7.6 1.9 10l1.2-3.8L0 3.8h3.8z" fill="white"/></svg>
                  </div>
                ))}
              </div>
              <div class="reviews-count">Based on {tpData.value.count} reviews on Trustpilot</div>
              <div class="reviews-label">What Our Customers Say</div>
            </div>
            <div class="reviews-grid">
              {tpData.value.reviews.slice(0, 3).map((r: any) => (
                <div key={r.name} class="rev-card" data-reveal>
                  <ReviewStars />
                  <p class="rev-text">{r.text}</p>
                  <div class="rev-author">
                    <div class="rev-avatar">{r.name.charAt(0)}</div>
                    <div>
                      <div class="rev-name">{r.name}</div>
                      <div class="rev-verified">Verified Purchase</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
      </section>

      {/* ════════ Service strip ════════ */}
      <section class="service">
          <div class="service-card" data-reveal>
            <svg width="40" height="28" viewBox="0 0 60 40" fill="none" aria-hidden="true">
              <rect width="60" height="40" rx="2" fill="#B22234"/>
              <rect y="3.08" width="60" height="3.08" fill="white"/>
              <rect y="9.23" width="60" height="3.08" fill="white"/>
              <rect y="15.38" width="60" height="3.08" fill="white"/>
              <rect y="21.54" width="60" height="3.08" fill="white"/>
              <rect y="27.69" width="60" height="3.08" fill="white"/>
              <rect y="33.85" width="60" height="3.08" fill="white"/>
              <rect width="24" height="21.54" fill="#3C3B6E"/>
            </svg>
            <div class="service-title">Thank You for Your Service</div>
            <div class="service-desc">Exclusive pricing for active military, veterans, first responders, and teachers.</div>
            <VerificationButton
              variant="secondary"
              size="sm"
              class="service-btn"
            />
          </div>
      </section>

      {/* ════════ Newsletter ════════ */}
      <section class="newsletter">
          <div data-reveal>
            <div class="nl-label">Stay Sharp</div>
            <div class="nl-title">New drops. Restocks. No spam.</div>
            <div class="nl-sub">Be the first to know when new products drop and restocks happen. One email, no fluff.</div>
            <form
              class="nl-form"
              preventdefault:submit
              onSubmit$={handleNewsletterSubmit}
              aria-label="Newsletter signup"
            >
              <input
                type="text"
                name="website"
                value={nlHoneypot.value}
                onInput$={(_, el) => { nlHoneypot.value = el.value; }}
                style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
              />
              <input
                type="email"
                class="nl-input"
                placeholder="your@email.com"
                aria-label="Email address"
                value={nlEmail.value}
                onInput$={(_, el) => { nlEmail.value = el.value; }}
                required
                disabled={nlState.value === 'sending'}
              />
              <button
                type="submit"
                class="nl-submit"
                disabled={nlState.value === 'sending'}
              >
                {nlState.value === 'sending' ? 'Subscribing…' : nlState.value === 'success' ? 'Subscribed ✓' : 'Subscribe'}
              </button>
            </form>
            {nlState.value === 'error' && (
              <p style="color:#ff6b6b;font-size:13px;margin-top:12px;font-family:var(--font-body);">{nlError.value}</p>
            )}
            {nlState.value === 'success' && (
              <p style="color:var(--accent-light);font-size:13px;margin-top:12px;font-family:var(--font-body);">Subscribed ✓ — see you in your inbox soon</p>
            )}
          </div>
      </section>
    </div>
  );
});

export const head = () => {
  const organizationSchema = generateOrganizationSchema();
  const websiteSchema = generateWebsiteSchema();

  return createSEOHead({
    title: 'Precision EDC',
    description: 'Quality EDC folding knives, fixed blade knives, and everyday tools that prove exceptional craftsmanship doesn\'t require exceptional prices. Pocket knives, kitchen knives, lanyard beads, and fidget spinners.',
    noindex: false,
    image: 'https://www.damneddesigns.com/social-image.jpg',
    ogUrl: 'https://www.damneddesigns.com/',
    links: [
      { rel: 'preload', as: 'image', type: 'image/avif', href: HeroImage_1024 },
    ],
    schemas: [organizationSchema, websiteSchema],
  });
};

import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
