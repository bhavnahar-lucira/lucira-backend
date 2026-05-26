/**
 * Cache Utility (Backend Port)
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_ENTRIES = 5000; // Increased to hold more items

const store = new Map();

const pruneCache = (maxEntries) => {
  if (store.size <= maxEntries) return;

  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= now && !entry.promise) {
      store.delete(key);
    }
  }

  while (store.size > maxEntries) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
};

const stableCacheKey = (parts) => JSON.stringify(parts);

async function getServerCache(key, loader, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = Date.now();
  const cached = store.get(key);

  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
      pruneCache(maxEntries);
      return value;
    })
    .catch((error) => {
      store.delete(key);
      throw error;
    });

  store.set(key, {
    promise,
    expiresAt: now + ttlMs,
  });

  return promise;
}
const clearAllCache = () => {
  store.clear();
};

module.exports = { getServerCache, stableCacheKey, clearAllCache };
