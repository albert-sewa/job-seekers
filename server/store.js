// In-memory cache for upstream search results. The server keeps no personal
// data at all — everything about a user lives in their browser. This cache
// only spares repeat API calls while the process is warm.
const cache = new Map();
const MAX_ENTRIES = 200;

export function cacheGet(key, maxAgeMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

export function cacheSet(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

export function cacheClear() {
  const n = cache.size;
  cache.clear();
  return n;
}
