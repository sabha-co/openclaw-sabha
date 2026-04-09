/**
 * Simple message dedup cache with TTL.
 *
 * Prevents duplicate processing when WebSocket reconnects deliver
 * messages that were already handled in a previous connection.
 */

type DedupEntry = {
  expiresAt: number;
};

export type DedupCache = {
  /** Returns true if the key was already marked (duplicate). */
  has(key: string): boolean;
  /** Mark a key as processed. Call only after successful handling. */
  mark(key: string): void;
  /** Number of entries currently tracked. */
  size(): number;
};

export function createDedupCache(opts: {
  ttlMs: number;
  maxSize: number;
}): DedupCache {
  const entries = new Map<string, DedupEntry>();
  let lastPurge = Date.now();

  function purge() {
    const now = Date.now();
    if (now - lastPurge < opts.ttlMs / 2) return;
    lastPurge = now;

    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    has(key: string): boolean {
      purge();
      return entries.has(key);
    },

    mark(key: string): void {
      purge();

      // Evict oldest if at capacity
      if (entries.size >= opts.maxSize) {
        const firstKey = entries.keys().next().value;
        if (firstKey !== undefined) entries.delete(firstKey);
      }

      entries.set(key, { expiresAt: Date.now() + opts.ttlMs });
    },

    size() {
      return entries.size;
    },
  };
}
