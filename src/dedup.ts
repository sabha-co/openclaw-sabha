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
  /** Mark a key as seen. */
  mark(key: string): void;
  /**
   * Remove a previously-marked key. Used to roll back an optimistic `mark`
   * when processing fails, so a subsequent reconnect-driven redelivery can
   * retry instead of being silently dropped as a duplicate.
   */
  unmark(key: string): void;
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

    unmark(key: string): void {
      entries.delete(key);
    },

    size() {
      return entries.size;
    },
  };
}
