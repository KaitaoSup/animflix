/**
 * Gestionnaire de cache mémoire avec éviction LRU et expiration TTL
 */
export class ExpiringLRUCache {
  constructor({ maxEntries = 500, defaultTTL = 1000 * 60 * 15 } = {}) {
    this.maxEntries = maxEntries;
    this.defaultTTL = defaultTTL;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() - item.timestamp > (item.ttl || this.defaultTTL)) {
      this.cache.delete(key);
      return undefined;
    }
    // Mise à jour de l'ordre LRU (déplacer à la fin de la Map)
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value, ttl = this.defaultTTL) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Éviction du plus ancien élément inséré
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now(), ttl });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  purgeExpired() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > (item.ttl || this.defaultTTL)) {
        this.cache.delete(key);
      }
    }
  }
}

// Caches bornés avec éviction automatique (protection contre les fuites mémoires)
export const metadataCache = new ExpiringLRUCache({ maxEntries: 1000, defaultTTL: 1000 * 60 * 60 * 24 }); // 24h
export const searchCache = new ExpiringLRUCache({ maxEntries: 200, defaultTTL: 1000 * 60 * 5 }); // 5 min
export const streamsCache = new ExpiringLRUCache({ maxEntries: 200, defaultTTL: 1000 * 60 * 60 }); // 1h
export const torrentFilesCache = new ExpiringLRUCache({ maxEntries: 300, defaultTTL: 1000 * 60 * 60 * 24 }); // 24h

// Balayage régulier toutes les 15 minutes des entrées expirées
setInterval(() => {
  metadataCache.purgeExpired();
  searchCache.purgeExpired();
  streamsCache.purgeExpired();
  torrentFilesCache.purgeExpired();
}, 1000 * 60 * 15).unref();
