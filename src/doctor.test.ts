import { describe, it, expect, afterEach } from "vitest";

import { runDoctor, formatDoctorReport, type DoctorReport } from "./doctor.js";
import type { ResolvedSabhaAccount } from "./accounts.js";
import type {
  SabhaWebSocketFactory,
  WebSocketLike,
} from "./monitor-websocket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubAccount(
  overrides: Partial<ResolvedSabhaAccount> = {},
): ResolvedSabhaAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "http://localhost:3000",
    apiBaseUrl: "http://localhost:3000/api/bots",
    botKey: "42-abc",
    webhookSecret: "whsec_test",
    botId: 42,
    botName: "TestBot",
    webhookPort: 8787,
    connectionMode: "websocket",
    websocketUrl: "",
    typingEnabled: false,
    dmPolicy: "open",
    allowFrom: [],
    allowPrivateAttachmentHosts: false,
    replyToMode: "first",
    rooms: {},
    ...overrides,
  };
}

/**
 * Build a scripted fake WebSocket. The `script` is a list of frames that
 * the fake will emit once the caller calls `send(...)` for a subscribe,
 * OR immediately after `open` for unsolicited frames tagged with
 * `phase: "before-subscribe"`. Keeps the test ergonomics simple — the
 * production check only cares about welcome → confirm_subscription.
 */
type ScriptFrame =
  | { phase: "on-open"; data: unknown }
  | { phase: "on-subscribe"; data: unknown }
  // Emit an error event instead of a normal frame. Simulates a server
  // resetting the socket mid-handshake.
  | { phase: "on-open-error"; error: Error };

function scriptedWebSocketFactory(
  script: ScriptFrame[],
): { factory: SabhaWebSocketFactory; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  const factory: SabhaWebSocketFactory = () => {
    const ws = new FakeWebSocket(script);
    sockets.push(ws);
    return ws;
  };
  return { factory, sockets };
}

class FakeWebSocket implements WebSocketLike {
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  closed = false;

  constructor(private readonly script: ScriptFrame[]) {
    // Fire "open" and the on-open frames on a microtask so the caller
    // has time to attach listeners.
    queueMicrotask(() => {
      this.emit("open");
      for (const frame of this.script) {
        if (frame.phase === "on-open") {
          this.deliver(frame.data);
        } else if (frame.phase === "on-open-error") {
          this.emit("error", frame.error);
        }
      }
    });
  }

  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: { toString: (enc: string) => string }) => void,
  ): void;
  on(
    event: "close",
    listener: (code: number, reason: Buffer) => void,
  ): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  send(data: string): void {
    // When the caller sends the subscribe frame, emit the on-subscribe
    // frames from the script.
    try {
      const parsed = JSON.parse(data) as { command?: string };
      if (parsed.command === "subscribe") {
        for (const frame of this.script) {
          if (frame.phase === "on-subscribe") {
            this.deliver(frame.data);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 1000, Buffer.from(""));
  }

  terminate(): void {
    this.close();
  }

  emitError(err: Error): void {
    this.emit("error", err);
  }

  emitClose(): void {
    this.close();
  }

  private deliver(data: unknown): void {
    const payload = {
      toString: (_enc: string) => JSON.stringify(data),
    };
    this.emit("message", payload);
  }

  private emit(event: string, ...args: unknown[]): void {
    const list = this.listeners[event];
    if (!list) return;
    for (const fn of list) fn(...args);
  }
}

function withMockedFetch(impl: (url: string) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    return impl(String(input));
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDoctor — config check", () => {
  it("fails config and skips downstream when baseUrl is empty", async () => {
    const report = await runDoctor({
      account: stubAccount({ baseUrl: "" }),
      // No factory needed because WS check is skipped
    });
    expect(report.allPassed).toBe(false);
    const config = report.checks.find((c) => c.name === "Config")!;
    expect(config.status).toBe("fail");
    expect(config.message).toContain("baseUrl is empty");
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("skip");
    const ws = report.checks.find((c) => c.name === "WebSocket subscribe")!;
    expect(ws.status).toBe("skip");
  });

  it("fails config when botKey does not match the expected shape", async () => {
    const report = await runDoctor({
      account: stubAccount({ botKey: "not-numeric" }),
    });
    const config = report.checks.find((c) => c.name === "Config")!;
    expect(config.status).toBe("fail");
    expect(config.message).toContain('botKey does not match "<id>-<token>"');
  });
});

describe("runDoctor — API check", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("reports ok and the first-page probe message on a 200 response", async () => {
    // listRooms is paginated; probe asks for perPage=1 and reports
    // reachability rather than a workspace-wide count (would mislead).
    restore = withMockedFetch(() => jsonResponse([{ id: 1 }]));
    const { factory } = scriptedWebSocketFactory([
      { phase: "on-open", data: { type: "welcome" } },
      {
        phase: "on-subscribe",
        data: {
          type: "confirm_subscription",
          identifier: JSON.stringify({ channel: "BotEventsChannel" }),
        },
      },
    ]);
    const report = await runDoctor({
      account: stubAccount(),
      webSocketFactory: factory,
      wsTimeoutMs: 500,
    });
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("ok");
    expect(api.message).toMatch(/reachable/);
  });

  it("reports ok with a no-rooms-yet hint when the first page is empty", async () => {
    restore = withMockedFetch(() => jsonResponse([]));
    const { factory } = scriptedWebSocketFactory([
      { phase: "on-open", data: { type: "welcome" } },
      {
        phase: "on-subscribe",
        data: {
          type: "confirm_subscription",
          identifier: JSON.stringify({ channel: "BotEventsChannel" }),
        },
      },
    ]);
    const report = await runDoctor({
      account: stubAccount(),
      webSocketFactory: factory,
      wsTimeoutMs: 500,
    });
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("ok");
    expect(api.message).toMatch(/no rooms visible/);
  });

  it("surfaces a specific hint on 401 (bot_key invalid)", async () => {
    restore = withMockedFetch(
      () => new Response("unauthorized", { status: 401 }),
    );
    const report = await runDoctor({
      account: stubAccount({ connectionMode: "webhook" }),
    });
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("fail");
    expect(api.message).toMatch(/401.*bot key likely invalid/);
  });

  it("surfaces a hint on 404 (apiBaseUrl likely wrong)", async () => {
    restore = withMockedFetch(
      () => new Response("not found", { status: 404 }),
    );
    const report = await runDoctor({
      account: stubAccount({ connectionMode: "webhook" }),
    });
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("fail");
    expect(api.message).toMatch(/404.*apiBaseUrl.*workspace/);
  });

  it("reports a network error with the underlying message", async () => {
    restore = withMockedFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const report = await runDoctor({
      account: stubAccount({ connectionMode: "webhook" }),
    });
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("fail");
    expect(api.message).toContain("ECONNREFUSED");
  });

  it("fails fast on a 503 without silently retrying", async () => {
    // Regression guard: the default SabhaClient retry runner would retry
    // a 503 up to 3 times with exponential backoff, making the doctor
    // probe hang for ~6s. The doctor must override this to attempts: 1.
    let calls = 0;
    restore = withMockedFetch(() => {
      calls++;
      return new Response("service unavailable", { status: 503 });
    });
    const start = Date.now();
    const report = await runDoctor({
      account: stubAccount({ connectionMode: "webhook" }),
    });
    const elapsed = Date.now() - start;
    const api = report.checks.find((c) => c.name === "API reachable")!;
    expect(api.status).toBe("fail");
    expect(api.message).toContain("503");
    expect(calls).toBe(1); // exactly one attempt — no silent retries
    expect(elapsed).toBeLessThan(1_000); // way under the default 6s retry envelope
  });
});

describe("runDoctor — WebSocket check", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("confirms BotEventsChannel subscription on a successful handshake", async () => {
    restore = withMockedFetch(() => jsonResponse([]));
    const { factory } = scriptedWebSocketFactory([
      { phase: "on-open", data: { type: "welcome" } },
      {
        phase: "on-subscribe",
        data: {
          type: "confirm_subscription",
          identifier: JSON.stringify({ channel: "BotEventsChannel" }),
        },
      },
    ]);
    const report = await runDoctor({
      account: stubAccount(),
      webSocketFactory: factory,
      wsTimeoutMs: 500,
    });
    const ws = report.checks.find((c) => c.name === "WebSocket subscribe")!;
    expect(ws.status).toBe("ok");
    expect(ws.message).toContain("confirmed");
    expect(report.allPassed).toBe(true);
  });

  it("reports fail when Sabha rejects the subscription", async () => {
    restore = withMockedFetch(() => jsonResponse([]));
    const { factory } = scriptedWebSocketFactory([
      { phase: "on-open", data: { type: "welcome" } },
      {
        phase: "on-subscribe",
        data: {
          type: "reject_subscription",
          identifier: JSON.stringify({ channel: "BotEventsChannel" }),
        },
      },
    ]);
    const report = await runDoctor({
      account: stubAccount(),
      webSocketFactory: factory,
      wsTimeoutMs: 500,
    });
    const ws = report.checks.find((c) => c.name === "WebSocket subscribe")!;
    expect(ws.status).toBe("fail");
    expect(ws.message).toContain("rejected");
    expect(report.allPassed).toBe(false);
  });

  it("reports the underlying error when the socket emits an error event", async () => {
    restore = withMockedFetch(() => jsonResponse([]));
    const { factory } = scriptedWebSocketFactory([
      { phase: "on-open-error", error: new Error("ECONNRESET") },
    ]);
    const report = await runDoctor({
      account: stubAccount(),
      webSocketFactory: factory,
      wsTimeoutMs: 500,
    });
    const ws = report.checks.find((c) => c.name === "WebSocket subscribe")!;
    expect(ws.status).toBe("fail");
    expect(ws.message).toContain("ECONNRESET");
    // The phase tracker should still be at "welcome" because we reached
    // "open" but never saw a welcome frame.
    expect(ws.message).toContain('phase "welcome"');
  });

  it("times out with a phase label when the server never sends welcome", async () => {
    restore = withMockedFetch(() => jsonResponse([]));
    const { factory } = scriptedWebSocketFactory([]); // no frames at all
    const start = Date.now();
    const report = await runDoctor({
      account: stubAccount(),
      webSocketFactory: factory,
      wsTimeoutMs: 50, // tight so the test is fast
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    const ws = report.checks.find((c) => c.name === "WebSocket subscribe")!;
    expect(ws.status).toBe("fail");
    expect(ws.message).toMatch(/Timed out in phase "welcome"/);
  });

  it("is skipped entirely in webhook mode with an informational warning", async () => {
    restore = withMockedFetch(() => jsonResponse([]));
    const report = await runDoctor({
      account: stubAccount({ connectionMode: "webhook" }),
    });
    const ws = report.checks.find((c) => c.name === "WebSocket subscribe");
    expect(ws).toBeUndefined();
    const webhook = report.checks.find((c) => c.name === "Webhook transport")!;
    expect(webhook.status).toBe("warn");
    expect(report.allPassed).toBe(true); // warn still counts as passing
  });
});

describe("formatDoctorReport", () => {
  it("renders a structured summary with status symbols", () => {
    const report: DoctorReport = {
      accountId: "production",
      checks: [
        { name: "Config", status: "ok", message: "baseUrl=https://sabha.co" },
        { name: "API reachable", status: "fail", message: "HTTP 401" },
        { name: "WebSocket subscribe", status: "skip", message: "n/a" },
      ],
      allPassed: false,
    };
    const out = formatDoctorReport(report);
    expect(out).toContain('Sabha doctor — bot account "production"');
    expect(out).toContain("✓ Config");
    expect(out).toContain("✗ API reachable");
    expect(out).toContain("○ WebSocket subscribe");
    expect(out).toContain("One or more checks failed.");
  });

  it("reports success when every check passed", () => {
    const report: DoctorReport = {
      accountId: "default",
      checks: [
        { name: "Config", status: "ok" },
        { name: "API reachable", status: "ok" },
      ],
      allPassed: true,
    };
    expect(formatDoctorReport(report)).toContain("All checks passed.");
  });
});

