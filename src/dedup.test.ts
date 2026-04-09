import { describe, it, expect, vi } from "vitest";
import { createDedupCache } from "./dedup.js";

describe("createDedupCache", () => {
  it("returns false for unknown keys, true after mark", () => {
    const cache = createDedupCache({ ttlMs: 60_000, maxSize: 100 });
    expect(cache.has("msg:1")).toBe(false);
    cache.mark("msg:1");
    expect(cache.has("msg:1")).toBe(true);
    expect(cache.has("msg:2")).toBe(false);
  });

  it("tracks size", () => {
    const cache = createDedupCache({ ttlMs: 60_000, maxSize: 100 });
    cache.mark("a");
    cache.mark("b");
    cache.mark("c");
    expect(cache.size()).toBe(3);
  });

  it("evicts oldest when at capacity", () => {
    const cache = createDedupCache({ ttlMs: 60_000, maxSize: 3 });
    cache.mark("a");
    cache.mark("b");
    cache.mark("c");
    expect(cache.size()).toBe(3);
    // At capacity, marking "d" evicts "a"
    cache.mark("d");
    expect(cache.size()).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = createDedupCache({ ttlMs: 100, maxSize: 100 });
      cache.mark("msg:1");
      expect(cache.has("msg:1")).toBe(true);

      vi.advanceTimersByTime(150);
      expect(cache.has("msg:1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows retry when mark is not called (processing failed)", () => {
    const cache = createDedupCache({ ttlMs: 60_000, maxSize: 100 });
    // Check but don't mark (simulates failed processing)
    expect(cache.has("msg:1")).toBe(false);
    // Same message arrives again — should not be considered duplicate
    expect(cache.has("msg:1")).toBe(false);
    // Now mark after successful processing
    cache.mark("msg:1");
    // Now it's a duplicate
    expect(cache.has("msg:1")).toBe(true);
  });
});
