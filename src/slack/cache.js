/**
 * In-memory LRU-style cache for Claude responses.
 *
 * Key design:
 * - TTL: 1 hour (configurable via CACHE_TTL_MS env var)
 * - Max entries: 50 (evicts oldest on overflow)
 * - Cache key: normalised query string (lowercase, collapsed whitespace)
 *
 * Common patterns that benefit most from caching:
 *   "zapier api access", "rwg pending", "angi not syncing", etc.
 */

const TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? '3600000', 10) || 3600000; // 1 hour default
const MAX_ENTRIES = 50;

/** @type {Map<string, { data: object, expiresAt: number }>} */
const store = new Map();

/**
 * Normalises a query string into a stable cache key.
 * @param {string} query
 * @returns {string}
 */
export function cacheKey(query) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Retrieves a cached response, or null if missing/expired.
 * @param {string} query
 * @returns {object|null}
 */
export function getCached(query) {
  const key = cacheKey(query);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Stores a response in the cache.
 * Evicts the oldest entry if the store is at capacity.
 * @param {string} query
 * @param {object} data
 */
export function setCached(query, data) {
  const key = cacheKey(query);

  // Evict oldest if at capacity
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }

  store.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

/**
 * Removes a specific entry from the cache.
 * Used to invalidate stale responses when feedback is submitted for a query.
 * @param {string} query
 */
export function deleteCache(query) {
  store.delete(cacheKey(query));
}

/**
 * Removes all expired entries. Can be called periodically to keep memory tidy.
 */
export function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}

/** Returns current cache stats for debugging. */
export function cacheStats() {
  return { size: store.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
