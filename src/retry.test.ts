import { describe, it, expect } from "vitest";

import {
  createSabhaRetryRunner,
  isRetryableSabhaError,
  parseRetryAfter,
  sabhaRetryAfterMs,
} from "./retry.js";
import { SabhaApiError } from "./client.js";

// Use a zero-delay runner in tests so retries happen synchronously on the
// microtask queue and we don't need fake timers.
const fastRunner = () =>
  createSabhaRetryRunner({
    retry: { minDelayMs: 0, maxDelayMs: 0, jitter: 0, attempts: 3 },
  });

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("  12  ")).toBe(12000);
  });

  it("parses HTTP-date into a positive delta from now", () => {
    const future = new Date(Date.now() + 4_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(5_000);
  });

  it("returns 0 for HTTP-dates in the past", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("returns undefined for missing, empty, or malformed headers", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });

  it("rejects negative seconds", () => {
    expect(parseRetryAfter("-3")).toBeUndefined();
  });
});

describe("isRetryableSabhaError", () => {
  it("is true for 429, 502, 503, 504", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(
        isRetryableSabhaError(new SabhaApiError(status, "", "http://x")),
      ).toBe(true);
    }
  });

  it("is false for 400, 401, 403, 404, 500", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      expect(
        isRetryableSabhaError(new SabhaApiError(status, "", "http://x")),
      ).toBe(false);
    }
  });

  it("is false for plain errors and non-error values", () => {
    expect(isRetryableSabhaError(new Error("boom"))).toBe(false);
    expect(isRetryableSabhaError(null)).toBe(false);
    expect(isRetryableSabhaError(undefined)).toBe(false);
    expect(isRetryableSabhaError("nope")).toBe(false);
    expect(isRetryableSabhaError(429)).toBe(false);
  });
});

describe("sabhaRetryAfterMs", () => {
  it("reads retryAfterMs from SabhaApiError", () => {
    const err = new SabhaApiError(429, "", "http://x", 1500);
    expect(sabhaRetryAfterMs(err)).toBe(1500);
  });

  it("returns undefined when absent or non-numeric", () => {
    expect(
      sabhaRetryAfterMs(new SabhaApiError(429, "", "http://x")),
    ).toBeUndefined();
    expect(sabhaRetryAfterMs({})).toBeUndefined();
    expect(sabhaRetryAfterMs(null)).toBeUndefined();
  });
});

describe("createSabhaRetryRunner", () => {
  it("retries a 429 failure and returns the eventual success", async () => {
    const runner = fastRunner();
    let calls = 0;
    const result = await runner(async () => {
      calls++;
      if (calls === 1) {
        throw new SabhaApiError(429, "slow down", "http://x", 0);
      }
      return "ok";
    }, "POST /messages");
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry 500 (non-retryable status)", async () => {
    const runner = fastRunner();
    let calls = 0;
    await expect(
      runner(async () => {
        calls++;
        throw new SabhaApiError(500, "boom", "http://x");
      }, "GET /rooms"),
    ).rejects.toBeInstanceOf(SabhaApiError);
    expect(calls).toBe(1);
  });

  it("retries 503 until max attempts, then throws the last error", async () => {
    const runner = fastRunner();
    let calls = 0;
    await expect(
      runner(async () => {
        calls++;
        throw new SabhaApiError(503, "unavailable", "http://x");
      }, "GET /rooms"),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3); // attempts: 3 in fastRunner
  });

  it("does not retry a plain network-shaped error (safety for non-idempotent POSTs)", async () => {
    const runner = fastRunner();
    let calls = 0;
    await expect(
      runner(async () => {
        calls++;
        throw new Error("ECONNRESET");
      }, "POST /messages"),
    ).rejects.toThrow("ECONNRESET");
    // Network-ish errors without a `status` field are NOT retried because
    // a POST may already have reached the server. See retry.ts rationale.
    expect(calls).toBe(1);
  });
});
