import { component$, type QRL } from '@qwik.dev/core';
import { theme } from '~/theme/theme.config';

/** Revision of the pre-generated asset variants (#425): bump when variants are re-encoded so cached URLs change. */
export const ASSET_VARIANT_REV = 2;

// Helper function to generate responsive srcset for hosted image assets
export const generateResponsiveSources = (src: string, widths: number[] = [320, 640, 1024, 1280]) => {
  // Check if this is a hosted asset-store URL
  const isHostedAsset = src.includes('/assets/') || src.includes('/assetspreview/') || src.includes(theme.domain);
  
  if (!isHostedAsset) {
    // For non-hosted images, return as-is
    return { 
      avif: null, 
      webp: null, 
      original: src,
      avifSrcset: null,
      webpSrcset: null,
      originalSrcset: null
    };
  }
  
  const baseUrl = src.split('?')[0]; // Remove existing query params
  // Preserve cache-busting version param if present (e.g. ?v=1234567890)
  const vMatch = src.match(/[?&]v=([^&]+)/);
  // #425: `r` is the variant revision. The hosted variants are cached immutable for a year (browser and edge); the 2026-10-31
  // re-encode (AVIF q50 -> 65/70, WebP/JPEG 85 for large and up) needs new URLs to reach browsers that cached the soft files.
  // The asset server ignores parameters it does not use.
  const vParam = `${vMatch ? `&v=${vMatch[1]}` : ''}&r=${ASSET_VARIANT_REV}`;

  // Map widths to appropriate hosted-asset presets
  // NOTE: w= param is ignored by PresetOnlyStrategy — dimensions come from preset only
  // Presets size the LONG edge (thumb 160, card 400, small 640, medium 1024, large 1280, xl 1600, xxl 2048, ultra 2560). For the
  // 4:5 product photos that is a real width of 128/320/512/819/1024/1280/1638/2048, so the width descriptors used by
  // RESPONSIVE_CONFIGS are those real widths and each maps to the preset that actually has it (#425: a 1280w descriptor used to
  // map to large, which is 1024 wide).
  const getPresetForWidth = (width: number) => {
    if (width <= 160) return 'thumb';
    if (width <= 320) return 'card';
    if (width <= 512) return 'small';
    if (width <= 819) return 'medium';
    if (width <= 1024) return 'large';
    if (width <= 1280) return 'xl';
    if (width <= 1638) return 'xxl';
    return 'ultra';
  };

  // Quality tiers: thumbnails get 75 (small, less visible), cards 80, large/hero 85
  // permittedQuality on server must include these values
  const getQualityForWidth = (width: number) => {
    if (width <= 320) return 75;   // thumbnails — artifacts invisible at small size
    if (width <= 800) return 80;   // product cards
    return 85;                     // PDP / hero — product detail benefits from higher fidelity
  };

  const avifSrcset = widths.map(w => {
    const preset = getPresetForWidth(w);
    const q = getQualityForWidth(w);
    return `${baseUrl}?preset=${preset}&format=avif&q=${q}${vParam} ${w}w`;
  }).join(', ');

  const webpSrcset = widths.map(w => {
    const preset = getPresetForWidth(w);
    const q = getQualityForWidth(w);
    return `${baseUrl}?preset=${preset}&format=webp&q=${q}${vParam} ${w}w`;
  }).join(', ');

  const originalSrcset = widths.map(w => {
    const preset = getPresetForWidth(w);
    return `${baseUrl}?preset=${preset}&format=jpg&q=80${vParam} ${w}w`;
  }).join(', ');

  // Single format URLs for fallback
  const separator = '?';
  const avifUrl = `${baseUrl}${separator}preset=large&format=avif&q=80${vParam}`;
  const webpUrl = `${baseUrl}${separator}preset=large&format=webp&q=80${vParam}`;
  
  return { 
    avif: avifUrl, 
    webp: webpUrl, 
    original: baseUrl,
    avifSrcset,
    webpSrcset,
    originalSrcset
  };
};

// Predefined responsive configurations for common use cases
export const RESPONSIVE_CONFIGS = {
  // Product detail main image. #425: up to xxl (1638w real): the 1024w cap rendered a 1014px desktop slot at DPR 2+ with under
  // half the pixels (Adrian: visibly soft). Variants are pre-generated on disk (no on-request transform). Phones pick by DPR
  // again: the slot is the full width on phones (the 70vw cap made 2x/3x phones take medium).
  productMain: {
    widths: [512, 819, 1024, 1280, 1638],
    sizes: '(max-width: 768px) 100vw, 1024px'
  },
  // Product card images: 512 = small, 819 = medium (real widths of a 4:5 photo; card slot is object-cover 3:4, ~1.07x zoom)
  productCard: {
    widths: [512, 819],
    sizes: '(max-width: 768px) 50vw, 320px'
  },
  // Thumbnail images - Added retina support (160 = thumb, 320 = card)
  thumbnail: {
    widths: [160, 320], // Added 2x density for crisp thumbnails
    sizes: '160px'
  },
  // Hero/banner images - Enhanced for very large displays
  hero: {
    widths: [640, 768, 1024, 1280, 1536, 1920, 2560, 3440],
    sizes: '100vw'
  }
};

/**
 * Generates preload link objects for critical images to be used in DocumentHead.
 * This enables SSR preloading of above-the-fold images for better LCP performance.
 * 
 * @param src - The image source URL
 * @param responsive - Responsive configuration key or 'none'
 * @param formats - Array of formats to preload (defaults to ['avif', 'webp', 'original'])
 * @returns Array of link objects for DocumentHead
 * 
 * @example
 * // In a route file:
 * export const head: DocumentHead = () => ({
 *   links: [
 *     ...generateImagePreloadLinks(productImage, 'productMain'),
 *     // other links...
 *   ]
 * });
 */
export const generateImagePreloadLinks = (
  src: string,
  responsive: keyof typeof RESPONSIVE_CONFIGS | 'none' = 'none',
  formats: ('avif' | 'webp' | 'original')[] = ['avif', 'webp', 'original']
) => {
  if (!src) return [];

  const config = responsive !== 'none' ? RESPONSIVE_CONFIGS[responsive] : null;
  const imageSources = generateResponsiveSources(
    src, 
    config?.widths || [320, 640, 1024, 1280]
  );

  const links: Array<{ 
    rel: string; 
    as: string; 
    href: string; 
    type?: string; 
    imagesrcset?: string; 
    imagesizes?: string;
    crossorigin?: string;
  }> = [];

  // Add preload links for each requested format
  if (formats.includes('avif') && imageSources.avif) {
    links.push({
      rel: 'preload',
      as: 'image',
      href: imageSources.avif,
      type: 'image/avif',
      imagesrcset: imageSources.avifSrcset || undefined,
      imagesizes: config?.sizes,
      crossorigin: (src.includes(`${theme.domain}/assetspreview`) || !src.startsWith('/')) ? 'anonymous' : undefined,
    });
  }

  if (formats.includes('webp') && imageSources.webp) {
    links.push({
      rel: 'preload',
      as: 'image',
      href: imageSources.webp,
      type: 'image/webp',
      imagesrcset: imageSources.webpSrcset || undefined,
      imagesizes: config?.sizes,
      crossorigin: (src.includes(`${theme.domain}/assetspreview`) || !src.startsWith('/')) ? 'anonymous' : undefined,
    });
  }

  if (formats.includes('original')) {
    links.push({
      rel: 'preload',
      as: 'image',
      href: imageSources.original,
      imagesrcset: imageSources.originalSrcset || undefined,
      imagesizes: config?.sizes,
      crossorigin: (src.includes(`${theme.domain}/assetspreview`) || !src.startsWith('/')) ? 'anonymous' : undefined,
    });
  }

  return links;
};

interface OptimizedImageProps { 
 src: string;
 alt: string;
 class?: string;
 loading?: 'lazy' | 'eager';
 priority?: boolean;
 /** Overrides the priority-derived hint (grid cards: only the first image is 'high'). */
 fetchPriority?: 'high' | 'low' | 'auto';
 /** Overrides the default async decoding. F1: never 'sync' — it held the first frame until the image decoded. */
 decoding?: 'async' | 'auto';
 width?: number;
 height?: number;
 onLoad?: QRL<() => void>;
 onClick$?: QRL<(event: Event) => void>;
 // Responsive image props
 srcset?: string; // Custom srcset override
 sizes?: string;  // Custom sizes override
 responsive?: keyof typeof RESPONSIVE_CONFIGS | 'none'; // Predefined responsive config
}


/**
 * New OptimizedImage - Simple, fast implementation with all the smart responsive logic
 *
 * Preserves all the intelligent image selection and responsive behavior while using
 * simple native img rendering for better performance.
 *
 * Features preserved:
 * - Smart responsive srcset generation
 * - Format optimization (AVIF, WebP, fallback)
 * - Preset mapping based on screen size
 * - Predefined responsive configurations
 * - Proper sizes attribute for responsive behavior
 * - All visual styling and aspect ratios
 *
 * Performance improvements:
 * - No complex state management
 * - No manual cache checking
 * - Simple native img rendering
 * - Browser-native lazy loading and caching
 */
export const OptimizedImage = component$<OptimizedImageProps>(({
 src,
 alt,
 class: className = '',
 loading: loadingProp,
 priority = false,
 fetchPriority: fetchPriorityProp,
 decoding: decodingProp,
 width,
 height,
 onLoad,
 onClick$,
 srcset: customSrcset,
 sizes: customSizes,
 responsive = 'none',
 ...rest
}) => {
 // Safari CORS fix: Add crossorigin attribute for external domain images
 const isCrossOrigin = src && (src.includes(`${theme.domain}/assetspreview`) || !src.startsWith('/'));

 // Generate responsive image sources using the same smart logic
 const config = responsive !== 'none' ? RESPONSIVE_CONFIGS[responsive] : null;
 const imageSources = generateResponsiveSources(
   src,
   config?.widths || [320, 640, 1024, 1280]
 );

 // Determine final srcset and sizes
 const finalSrcset = customSrcset || (config ? imageSources.originalSrcset : undefined);
 const finalSizes = customSizes || config?.sizes || (width ? `${width}px` : undefined);

 // For hosted assets, ensure fallback src has format to avoid raw PNG
 const isHostedAsset = src && (src.includes('/assets/') || src.includes(theme.domain));
 const fallbackSrc = isHostedAsset ? `${src.split('?')[0]}?preset=large&format=jpg&q=80&r=${ASSET_VARIANT_REV}` : src;

 // Simple native picture element with all the smart responsive logic and format optimization
 return (
   <picture>
     {/* AVIF format for modern browsers */}
     {imageSources.avifSrcset && (
       <source
         srcset={imageSources.avifSrcset}
         sizes={finalSizes}
         type="image/avif"
       />
     )}

     {/* WebP format for broader support */}
     {imageSources.webpSrcset && (
       <source
         srcset={imageSources.webpSrcset}
         sizes={finalSizes}
         type="image/webp"
       />
     )}

     {/* Fallback img with original format - CSS classes applied here */}
     <img
       src={fallbackSrc}
       srcset={finalSrcset || undefined}
       sizes={finalSizes}
       alt={alt}
       width={width}
       height={height}
       loading={loadingProp ?? (priority ? 'eager' : 'lazy')}
       fetchPriority={fetchPriorityProp ?? (priority ? 'high' : undefined)}
       decoding={decodingProp ?? 'async'}
       class={className}
       crossOrigin={isCrossOrigin ? 'anonymous' : undefined}
       onLoad$={onLoad}
       onClick$={onClick$}
       {...rest}
     />
   </picture>
 );
});
