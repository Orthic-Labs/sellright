/**
 * Performance monitoring utilities for Qwik applications
 * Non-intrusive monitoring that respects Qwik's resumability
 */

export interface PerformanceMetrics {
  FCP?: number;
  LCP?: number;
  FID?: number;
  CLS?: number;
  TTFB?: number;
}

/**
 * Collect Core Web Vitals without affecting performance
 * Only runs in browser and doesn't block anything
 */
export const collectWebVitals = (callback?: (metrics: PerformanceMetrics) => void) => {
  if (typeof window === 'undefined') return;

  const metrics: PerformanceMetrics = {};

  // Safely try to collect metrics
  try {
    // First Contentful Paint
    const paintEntries = performance.getEntriesByType('paint');
    const fcpEntry = paintEntries.find(entry => entry.name === 'first-contentful-paint');
    if (fcpEntry) {
      metrics.FCP = fcpEntry.startTime;
    }

    // Time to First Byte
    const navigationEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (navigationEntries.length > 0) {
      metrics.TTFB = navigationEntries[0].responseStart - navigationEntries[0].requestStart;
    }

    // Use Web Vitals API if available (modern browsers)
    if ('PerformanceObserver' in window) {
      // Largest Contentful Paint
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1] as any;
        metrics.LCP = lastEntry.startTime;
        callback?.(metrics);
      }).observe({ entryTypes: ['largest-contentful-paint'] });

      // First Input Delay
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry: any) => {
          metrics.FID = entry.processingStart - entry.startTime;
          callback?.(metrics);
        });
      }).observe({ entryTypes: ['first-input'] });

      // Cumulative Layout Shift
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        let clsValue = 0;
        entries.forEach((entry: any) => {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        });
        metrics.CLS = clsValue;
        callback?.(metrics);
      }).observe({ entryTypes: ['layout-shift'] });
    }

    // Initial callback with available metrics
    if (Object.keys(metrics).length > 0) {
      callback?.(metrics);
    }
  } catch (error) {
    // Fail silently - performance monitoring shouldn't break the app
    console.debug('Performance monitoring error:', error);
  }
};

/**
 * Log performance metrics to console in development
 * Can be extended to send to analytics in production
 */
export const logPerformanceMetrics = (metrics: PerformanceMetrics) => {
  if (import.meta.env.DEV) {
    console.group('🚀 Performance Metrics');
    if (metrics.FCP) console.log(`First Contentful Paint: ${Math.round(metrics.FCP)}ms`);
    if (metrics.LCP) console.log(`Largest Contentful Paint: ${Math.round(metrics.LCP)}ms`);
    if (metrics.FID) console.log(`First Input Delay: ${Math.round(metrics.FID)}ms`);
    if (metrics.CLS) console.log(`Cumulative Layout Shift: ${metrics.CLS.toFixed(3)}`);
    if (metrics.TTFB) console.log(`Time to First Byte: ${Math.round(metrics.TTFB)}ms`);
    console.groupEnd();
  }
};

/**
 * Bundle size monitoring utility
 */
export const logBundleInfo = () => {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    // Estimate JavaScript bundle size from network
    const navigationEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (navigationEntries.length > 0) {
      const entry = navigationEntries[0];
      const transferSize = entry.transferSize || 0;
      console.log(`📦 Estimated bundle transfer size: ${Math.round(transferSize / 1024)}KB`);
    }
  }
};

/**
 * Route prefetching utilities for critical navigation paths
 * Implements zero-risk prefetching that doesn't affect current functionality
 */

export interface PrefetchOptions {
  priority?: 'high' | 'low';
  crossOrigin?: 'anonymous' | 'use-credentials';
  as?: 'document' | 'script' | 'style' | 'fetch';
}

/**
 * Prefetch a route by adding a link element to the document head
 * Safe implementation that fails silently if prefetch is not supported
 */
export const prefetchRoute = (href: string, options: PrefetchOptions = {}) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  try {
    // Check if already prefetched
    const existingLink = document.querySelector(`link[rel="prefetch"][href="${href}"]`);
    if (existingLink) {
      return;
    }

    // Create prefetch link
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    
    if (options.priority) {
      link.setAttribute('importance', options.priority);
    }
    
    if (options.crossOrigin) {
      link.crossOrigin = options.crossOrigin;
    }
    
    if (options.as) {
      link.as = options.as;
    }

    // Add to document head
    document.head.appendChild(link);
    
    if (import.meta.env.DEV) {
      console.log(`🔗 Prefetching route: ${href}`);
    }
  } catch (error) {
    // Fail silently - prefetching is an optimization, not critical functionality
    console.debug('Prefetch error (non-critical):', error);
  }
};

/**
 * Prefetch multiple routes at once
 * Useful for prefetching a user's likely navigation path
 */
export const prefetchRoutes = (routes: string[], options: PrefetchOptions = {}) => {
  routes.forEach(route => prefetchRoute(route, options));
};

/**
 * Smart prefetching based on user interaction patterns
 * Prefetches routes when user shows intent (hover, focus, etc.)
 */
export const smartPrefetch = (href: string, trigger: 'hover' | 'focus' | 'visible' = 'hover') => {
  if (typeof window === 'undefined') return;

  const prefetchOnInteraction = () => {
    prefetchRoute(href, { priority: 'high' });
  };

  switch (trigger) {
    case 'hover':
      // Prefetch on mouse enter with slight delay to avoid excessive prefetching
      let hoverTimer: number;
      const onMouseEnter = () => {
        hoverTimer = window.setTimeout(prefetchOnInteraction, 100);
      };
      const onMouseLeave = () => {
        if (hoverTimer) clearTimeout(hoverTimer);
      };
      return { onMouseEnter, onMouseLeave };
      
    case 'focus':
      return { onFocus: prefetchOnInteraction };
      
    case 'visible':
      // Use Intersection Observer for visible prefetching
      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              prefetchOnInteraction();
              observer.disconnect();
            }
          });
        }, { threshold: 0.1 });
        
        return { observer };
      }
      break;
  }
  
  return {};
};

/**
 * Checkout-specific prefetching strategy
 * Prefetches confirmation page when user reaches payment step
 */
export const prefetchCheckoutFlow = (currentStep: 'address' | 'payment' | 'review') => {
  switch (currentStep) {
    case 'payment':
      // User is at payment step - high likelihood they'll complete checkout
      prefetchRoute('/checkout/confirmation/[code]', { 
        priority: 'high',
        as: 'document'
      });
      break;
    case 'review':
      // User is reviewing order - very high likelihood of completion
      prefetchRoute('/checkout/confirmation/[code]', { 
        priority: 'high',
        as: 'document'
      });
      // Also prefetch account pages they might visit after
      prefetchRoutes(['/account', '/account/orders'], { priority: 'low' });
      break;
  }
};

/**
 * Prefetch resources based on cart state
 * Safe utility that enhances performance without affecting functionality
 */
export const prefetchByCartState = (hasItems: boolean, itemCount: number) => {
  if (!hasItems) {
    // Empty cart - prefetch shop and product pages
    prefetchRoutes(['/shop'], { priority: 'low' });
  } else if (itemCount > 0) {
    // Has items - prefetch checkout flow
    prefetchRoute('/checkout', { priority: 'low' });
    
    // If substantial cart, prefetch confirmation template
    if (itemCount >= 2) {
      prefetchRoute('/checkout/confirmation/[code]', { 
        priority: 'low',
        as: 'document'
      });
    }
  }
};
