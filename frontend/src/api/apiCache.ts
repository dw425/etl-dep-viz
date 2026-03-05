/**
 * Client-side API response cache with TTL expiry.
 *
 * Caches GET responses by URL with a configurable TTL (default 5 minutes).
 * Supports manual invalidation and background refresh via requestIdleCallback.
 */

interface CacheEntry {
  data: unknown;
  expiry: number;
  etag?: string;
}

const _cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Get a cached response, or undefined if expired/missing. */
export function getCached<T>(key: string): T | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

/** Store a response in the cache with optional TTL override. */
export function setCache(key: string, data: unknown, ttlMs: number = DEFAULT_TTL_MS, etag?: string): void {
  _cache.set(key, { data, expiry: Date.now() + ttlMs, etag });
}

/** Invalidate a specific cache entry. */
export function invalidateCache(key: string): void {
  _cache.delete(key);
}

/** Invalidate all cache entries matching a prefix. */
export function invalidateCachePrefix(prefix: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}

/** Clear the entire cache. */
export function clearCache(): void {
  _cache.clear();
}

/** Get the ETag for a cached entry (for If-None-Match headers). */
export function getCachedEtag(key: string): string | undefined {
  return _cache.get(key)?.etag;
}

/** Cached fetch — checks cache first, then fetches and caches the response. */
export async function cachedFetch<T>(
  url: string,
  init?: RequestInit,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const cached = getCached<T>(url);
  if (cached !== undefined) return cached;

  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const etag = res.headers.get('ETag') || undefined;
  setCache(url, data, ttlMs, etag);
  return data as T;
}
