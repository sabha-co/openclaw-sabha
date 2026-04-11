import { describe, it, expect, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { buildWebSocketUrl, monitorSabha } from "./monitor.js";
import type { ResolvedBotAccount } from "./bot-accounts.js";

describe("buildWebSocketUrl", () => {
  it("converts http to ws and appends /cable", () => {
    const url = buildWebSocketUrl("http://localhost:3000", "42-abc");
    expect(url).toBe("ws://localhost:3000/cable?bot_key=42-abc");
  });

  it("converts https to wss", () => {
    const url = buildWebSocketUrl("https://chat.example.com", "42-abc");
    expect(url).toBe("wss://chat.example.com/cable?bot_key=42-abc");
  });

  it("includes workspace ID as wid for multi-tenant URLs", () => {
    const url = buildWebSocketUrl("http://localhost:3000/1000006", "42-abc");
    expect(url).toBe("ws://localhost:3000/cable?bot_key=42-abc&wid=1000006");
  });

  it("includes wid for production multi-tenant URLs", () => {
    const url = buildWebSocketUrl("https://sabha.co/1000006", "42-abc");
    expect(url).toBe("wss://sabha.co/cable?bot_key=42-abc&wid=1000006");
  });

  it("uses websocketUrl when provided", () => {
    const url = buildWebSocketUrl(
      "http://localhost:3000",
      "42-abc",
      "ws://custom:8080/cable?bot_key=42-abc",
    );
    expect(url).toBe("ws://custom:8080/cable?bot_key=42-abc");
  });
});

describe("monitorSabha — logging", () => {
  // Minimal ResolvedBotAccount stub. We only exercise the boot + log path
  // (aborted signal short-circuits runWithReconnect before a socket opens),
  // so most runtime fields can be defaults.
  function stubBotAccount(
    overrides: Partial<ResolvedBotAccount> = {},
  ): ResolvedBotAccount {
    return {
      accountId: "default",
      enabled: true,
      baseUrl: "http://localhost:3000",
      botKey: "42-abc",
      botId: 42,
      botName: "TestBot",
      webhookPort: 8787,
      connectionMode: "websocket",
      websocketUrl: "",
      typingEnabled: false,
      dmPolicy: "open",
      allowFrom: [],
      allowPrivateAttachmentHosts: false,
      ...overrides,
    };
  }

  // Runtime is only used by processInboundMessage (which isn't reached
  // when the monitor exits on an already-aborted signal), so a typed empty
  // stub is safe.
  const stubRuntime = {} as unknown as PluginRuntime;

  async function runWithAbortedSignal(
    botAccount: ResolvedBotAccount,
    logger: { info: (msg: string) => void; error: (msg: string) => void },
  ) {
    const controller = new AbortController();
    controller.abort();
    await monitorSabha({
      botAccount,
      config: { channels: { sabha: {} } } as never,
      runtime: stubRuntime,
      abortSignal: controller.signal,
      logger,
    });
  }

  it("includes the bot account id in the connect log line for the default account", async () => {
    const info = vi.fn();
    const error = vi.fn();
    await runWithAbortedSignal(stubBotAccount(), { info, error });
    expect(
      info.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.startsWith("[sabha:default] Connecting"),
      ),
    ).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("uses the named bot account id when running under a non-default account", async () => {
    const info = vi.fn();
    await runWithAbortedSignal(
      stubBotAccount({ accountId: "staging", botKey: "99-stg" }),
      { info, error: vi.fn() },
    );
    expect(
      info.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.startsWith("[sabha:staging] Connecting"),
      ),
    ).toBe(true);
  });

  it("redacts the bot_key query parameter in the connect log", async () => {
    const info = vi.fn();
    await runWithAbortedSignal(
      stubBotAccount({ botKey: "42-SecretKey" }),
      { info, error: vi.fn() },
    );
    const connectLine = info.mock.calls
      .map(([msg]) => (typeof msg === "string" ? msg : ""))
      .find((msg) => msg.includes("Connecting"));
    expect(connectLine).toBeDefined();
    expect(connectLine).toContain("bot_key=***");
    expect(connectLine).not.toContain("42-SecretKey");
  });
});
