/**
 * Query Deduplication Service
 * Prevents duplicate GraphQL queries from running simultaneously
 * and implements intelligent caching for performance optimization.
 *
 * Used to wrap key product/stock queries so rapid navigation
 * or double-clicks don't fire duplicate requests.
 */

interface PendingQuery<T> {
  promise: Promise<T>;
  timestamp: number;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class QueryDeduplicationService {
  private pendingQueries = new Map<string, PendingQuery<any>>();
  private cache = new Map<string, CacheEntry<any>>();

  /**
   * Execute a query with deduplication and optional caching.
   * If the same queryKey is already in-flight, returns the existing promise.
   * If a cached result exists and is within TTL, returns it immediately.
   */
  async executeQuery<T>(
    queryKey: string,
    queryFn: () => Promise<T>,
    options: {
      ttl?: number;
      forceRefresh?: boolean;
      timeout?: number;
    } = {}
  ): Promise<T> {
    const { ttl = 0, forceRefresh = false, timeout = 10000 } = options;
    const now = Date.now();

    // Check cache first (if TTL is set and not forcing refresh)
    if (ttl > 0 && !forceRefresh) {
      const cached = this.cache.get(queryKey);
      if (cached && (now - cached.timestamp) < cached.ttl) {
        return cached.data;
      }
    }

    // Check if query is already pending (deduplication)
    const pending = this.pendingQueries.get(queryKey);
    if (pending) {
      const age = now - pending.timestamp;
      if (age < timeout) {
        return pending.promise;
      } else {
        this.pendingQueries.delete(queryKey);
      }
    }

    // Execute new query
    const promise = queryFn().then(
      (result) => {
        if (ttl > 0) {
          this.cache.set(queryKey, { data: result, timestamp: Date.now(), ttl });
        }
        this.pendingQueries.delete(queryKey);
        return result;
      },
      (error) => {
        this.pendingQueries.delete(queryKey);
        throw error;
      }
    );

    this.pendingQueries.set(queryKey, { promise, timestamp: now });
    return promise;
  }

  /** Clear all cached entries and pending queries */
  clear(): void {
    this.cache.clear();
    this.pendingQueries.clear();
  }

  /** Remove expired cache entries */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if ((now - entry.timestamp) >= entry.ttl) {
        this.cache.delete(key);
      }
    }
  }
}

export const queryDeduplication = new QueryDeduplicationService();

// Cleanup expired cache entries every 5 minutes (browser only)
if (typeof window !== 'undefined') {
  setInterval(() => {
    queryDeduplication.cleanupCache();
  }, 5 * 60 * 1000);
}
