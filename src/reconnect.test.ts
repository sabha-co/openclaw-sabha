import { describe, it, expect, vi } from "vitest";
import { runWithReconnect } from "./reconnect.js";

describe("runWithReconnect", () => {
  it("calls connectFn and retries on resolve", async () => {
    let calls = 0;
    const abort = new AbortController();

    const connectFn = async () => {
      calls++;
      if (calls >= 3) abort.abort();
    };

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      initialDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(calls).toBe(3);
  });

  it("resets delay on normal resolve", async () => {
    const delays: number[] = [];
    let calls = 0;
    const abort = new AbortController();

    await runWithReconnect(
      async () => {
        calls++;
        if (calls >= 3) abort.abort();
      },
      {
        abortSignal: abort.signal,
        initialDelayMs: 10,
        onReconnect: (d) => delays.push(d),
      },
    );

    // All delays should be the initial delay (reset on resolve)
    for (const d of delays) {
      expect(d).toBe(10);
    }
  });

  it("increases delay on error (exponential backoff)", async () => {
    const delays: number[] = [];
    let calls = 0;
    const abort = new AbortController();

    await runWithReconnect(
      async () => {
        calls++;
        if (calls >= 4) abort.abort();
        throw new Error("fail");
      },
      {
        abortSignal: abort.signal,
        initialDelayMs: 10,
        maxDelayMs: 100,
        onError: () => {},
        onReconnect: (d) => delays.push(d),
      },
    );

    expect(delays[0]).toBe(10);
    expect(delays[1]).toBe(20);
    expect(delays[2]).toBe(40);
  });

  it("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];
    let calls = 0;
    const abort = new AbortController();

    await runWithReconnect(
      async () => {
        calls++;
        if (calls >= 6) abort.abort();
        throw new Error("fail");
      },
      {
        abortSignal: abort.signal,
        initialDelayMs: 10,
        maxDelayMs: 30,
        onError: () => {},
        onReconnect: (d) => delays.push(d),
      },
    );

    // Should cap at 30
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(30);
  });

  it("stops when shouldReconnect returns false", async () => {
    let calls = 0;

    await runWithReconnect(
      async () => {
        calls++;
        throw new Error("fail");
      },
      {
        initialDelayMs: 1,
        onError: () => {},
        shouldReconnect: ({ attempt }) => attempt < 2,
      },
    );

    // Errors increment attempt: 0, 1, 2 — stops when attempt=2 returns false
    expect(calls).toBe(3);
  });

  it("stops immediately on abort", async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;

    await runWithReconnect(
      async () => { calls++; },
      { abortSignal: abort.signal, initialDelayMs: 1 },
    );

    expect(calls).toBe(0);
  });

  it("applies jitter when jitterRatio > 0", async () => {
    const delays: number[] = [];
    let calls = 0;
    const abort = new AbortController();

    await runWithReconnect(
      async () => {
        calls++;
        if (calls >= 2) abort.abort();
      },
      {
        abortSignal: abort.signal,
        initialDelayMs: 100,
        jitterRatio: 0.5,
        random: () => 0.75,
        onReconnect: (d) => delays.push(d),
      },
    );

    // With jitter ratio 0.5 and random 0.75:
    // spread = 100 * 0.5 = 50, result = 100 - 50 + 0.75 * 100 = 125
    expect(delays[0]).toBe(125);
  });
});
