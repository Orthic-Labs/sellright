/**
 * Global Intersection Observer Singleton
 * Reduces performance overhead by using a single observer instance
 * across all components instead of creating multiple observers
 */

interface ObserverCallback {
  element: Element;
  callback: () => void;
  options: {
    rootMargin?: string;
    threshold?: number;
    once?: boolean;
  };
}

class GlobalIntersectionObserver {
  private static instance: GlobalIntersectionObserver;
  private observers = new Map<string, IntersectionObserver>();
  private callbacks = new Map<Element, ObserverCallback>();

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): GlobalIntersectionObserver {
    if (!this.instance) {
      this.instance = new GlobalIntersectionObserver();
    }
    return this.instance;
  }

  /**
   * Get or create observer for specific configuration
   */
  private getObserver(config: { rootMargin?: string; threshold?: number }): IntersectionObserver {
    const key = `${config.rootMargin || '0px'}-${config.threshold || 0}`;
    
    if (!this.observers.has(key)) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const callbackData = this.callbacks.get(entry.target);
              if (callbackData) {
                callbackData.callback();
                
                // Remove if it's a one-time callback
                if (callbackData.options.once !== false) {
                  this.unobserve(entry.target);
                }
              }
            }
          });
        },
        {
          rootMargin: config.rootMargin || '0px',
          threshold: config.threshold || 0
        }
      );
      
      this.observers.set(key, observer);
    }
    
    return this.observers.get(key)!;
  }

  /**
   * Observe an element with callback
   */
  observe(
    element: Element, 
    callback: () => void, 
    options: { rootMargin?: string; threshold?: number; once?: boolean } = {}
  ): void {
    // Store callback data
    this.callbacks.set(element, { element, callback, options });
    
    // Get appropriate observer and start observing
    const observer = this.getObserver({
      rootMargin: options.rootMargin,
      threshold: options.threshold
    });
    
    observer.observe(element);
  }

  /**
   * Stop observing an element
   */
  unobserve(element: Element): void {
    const callbackData = this.callbacks.get(element);
    if (callbackData) {
      // Find the right observer and unobserve
      const observer = this.getObserver({
        rootMargin: callbackData.options.rootMargin,
        threshold: callbackData.options.threshold
      });
      
      observer.unobserve(element);
      this.callbacks.delete(element);
    }
  }

  /**
   * Clean up all observers (useful for testing or cleanup)
   */
  disconnect(): void {
    this.observers.forEach(observer => observer.disconnect());
    this.observers.clear();
    this.callbacks.clear();
  }

  /**
   * Get stats for debugging
   */
  getStats(): { observerCount: number; elementCount: number } {
    return {
      observerCount: this.observers.size,
      elementCount: this.callbacks.size
    };
  }
}

// Export singleton instance
export const globalIntersectionObserver = GlobalIntersectionObserver.getInstance();

// Export for debugging
export { GlobalIntersectionObserver };
