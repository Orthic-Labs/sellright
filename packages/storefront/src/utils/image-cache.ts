import { $ } from '@qwik.dev/core';

// 🚀 CROSS-PAGE PERSISTENT CACHE - Survives page refreshes and navigation
// Limit cache size to prevent memory leaks and storage bloat
const MAX_CACHE_SIZE = 100;
const STORAGE_KEY = 'dd_cached_images';

// Load seen images from sessionStorage on initialization
const loadSeenImages = (): Set<string> => {
  if (typeof window === 'undefined') {
    return new Set(); // SSR safety
  }

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return new Set(stored ? JSON.parse(stored) : []);
  } catch {
    // Storage disabled or corrupted
    return new Set();
  }
};

// Save seen images to sessionStorage
const saveSeenImages = (images: Set<string>) => {
  if (typeof window === 'undefined') {
    return; // SSR safety
  }

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...images]));
  } catch {
    // Storage full or disabled - fail silently
  }
};

// Initialize with persistent data
const seenImages = loadSeenImages();

// Clear cache when it gets too large to prevent memory leaks and storage bloat
const maintainCacheSize = () => {
  if (seenImages.size > MAX_CACHE_SIZE) {
    // Clear oldest entries (Set maintains insertion order)
    const entries = Array.from(seenImages);
    const toKeep = entries.slice(-MAX_CACHE_SIZE / 2); // Keep newest half
    seenImages.clear();
    toKeep.forEach(url => seenImages.add(url));

    // Update persistent storage
    saveSeenImages(seenImages);
  }
};

/**
 * Synchronously checks if an image is likely cached
 * @param src - The image source URL to check
 * @returns boolean - true if likely cached, false if not
 */
export const isImageLikelyCached = (src: string): boolean => {
  try {
    // If we've seen this image before in this session, assume it's cached
    if (seenImages.has(src)) {
      return true;
    }

    const img = new Image();
    img.src = src;

    // If complete immediately and has dimensions, it's cached
    const isCached = img.complete && img.naturalWidth > 0;

    if (isCached) {
      seenImages.add(src);
      saveSeenImages(seenImages); // Persist to storage
    }

    return isCached;
  } catch {
    return false;
  }
};

/**
 * Checks if an image is already cached in the browser
 * @param src - The image source URL to check
 * @returns Promise<boolean> - true if cached, false if not
 */
export const isImageCached = $((src: string): Promise<boolean> => {
  return new Promise((resolve) => {
    // If we've seen this image before in this session, assume it's cached
    if (seenImages.has(src)) {
      resolve(true);
      return;
    }

    const img = new Image();

    // Set up event handlers before setting src
    img.onload = () => {
      // Image loaded successfully - add to persistent cache
      seenImages.add(src);
      saveSeenImages(seenImages);
      resolve(true);
    };

    img.onerror = () => {
      // Image failed to load
      resolve(false);
    };

    // Check if already complete before setting src (in case it's already cached)
    if (img.complete && img.naturalWidth > 0) {
      seenImages.add(src);
      saveSeenImages(seenImages);
      resolve(true);
      return;
    }

    // Set src to trigger load
    img.src = src;

    // Check immediately after setting src for cached images
    setTimeout(() => {
      if (img.complete && img.naturalWidth > 0) {
        seenImages.add(src);
        saveSeenImages(seenImages);
        resolve(true);
      }
    }, 0);
  });
});

/**
 * Preloads an image in the background for better caching
 * @param src - The image source URL to preload
 * @returns Promise that resolves when image loads or rejects on error
 */
export const preloadImage = $((src: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    // 🚀 FIXED: Check if we're on the server-side
    if (typeof window === 'undefined' || typeof Image === 'undefined') {
      // On server-side, just resolve immediately
      resolve();
      return;
    }

    const img = new Image();

    img.onload = () => {
      // Add to persistent cache when preload completes
      seenImages.add(src);
      saveSeenImages(seenImages);
      maintainCacheSize();
      resolve();
    };

    img.onerror = () => {
      // Don't crash on image load failures
      reject(new Error(`Failed to preload image: ${src}`));
    };

    img.src = src;
  });
});

/**
 * Applies conditional loading state based on image cache status
 * @param src - The image source URL to check
 * @param setLoading - Function to set loading state
 * @param timeout - Timeout duration for loading state (default: 300ms)
 */
export const applyConditionalLoading = $((
  src: string, 
  setLoading: (loading: boolean) => void, 
  timeout: number = 300
) => {
  isImageCached(src).then((cached) => {
    if (!cached) {
      setLoading(true);
      setTimeout(() => {
        setLoading(false);
      }, timeout);
    }
  });
});

/**
 * Clears the persistent image cache (useful for testing or troubleshooting)
 */
export const clearImageCache = () => {
  seenImages.clear();
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage disabled - fail silently
    }
  }
};

/**
 * Gets the current cache size (useful for debugging)
 */
export const getImageCacheSize = () => seenImages.size;

/**
 * Gets all cached image URLs (useful for debugging)
 */
export const getCachedImageUrls = () => [...seenImages];

/**
 * Test function to verify cross-page persistence (for console testing)
 * Usage: Open console and run: window.testImageCache()
 */
if (typeof window !== 'undefined') {
  (window as any).testImageCache = () => {
    console.log('🖼️ Image Cache Test:');
    console.log('Cache size:', getImageCacheSize());
    console.log('Cached URLs:', getCachedImageUrls());
    console.log('SessionStorage key:', STORAGE_KEY);

    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      console.log('Raw storage data:', stored);
    } catch (e) {
      console.log('Storage access failed:', e);
    }
  };

  (window as any).clearImageCache = clearImageCache;
}
