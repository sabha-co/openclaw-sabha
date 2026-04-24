import { describe, it, expect } from "vitest";
import { sabhaPlugin } from "./channel.js";
import { resolveBotAccount } from "./bot-accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function makeCfg(sabha?: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("resolveBotAccount", () => {
  it("resolves from config", () => {
    const cfg = makeCfg({
      botAccounts: {
        default: {
          baseUrl: "https://sabha.co/1000006",
          botKey: "42-AbCdEfGhIjKl",
        },
      },
    });
    const account = resolveBotAccount({ cfg });
    expect(account.baseUrl).toBe("https://sabha.co/1000006");
    expect(account.botKey).toBe("42-AbCdEfGhIjKl");
    expect(account.botId).toBe(42);
  });

  it("defaults connectionMode to websocket", () => {
    const cfg = makeCfg({
      botAccounts: { default: { baseUrl: "https://chat.example.com", botKey: "1-xyz" } },
    });
    expect(resolveBotAccount({ cfg }).connectionMode).toBe("websocket");
  });

  it("respects explicit webhook connectionMode", () => {
    const cfg = makeCfg({
      botAccounts: {
        default: {
          baseUrl: "https://chat.example.com",
          botKey: "1-xyz",
          connectionMode: "webhook",
        },
      },
    });
    expect(resolveBotAccount({ cfg }).connectionMode).toBe("webhook");
  });

  it("defaults dmPolicy to open", () => {
    const cfg = makeCfg({
      botAccounts: { default: { baseUrl: "x", botKey: "1-a" } },
    });
    expect(resolveBotAccount({ cfg }).dmPolicy).toBe("open");
  });

  it("returns empty strings for missing config", () => {
    const account = resolveBotAccount({ cfg: makeCfg() });
    expect(account.baseUrl).toBe("");
    expect(account.botKey).toBe("");
    expect(account.botId).toBe(0);
  });
});

describe("sabhaPlugin.config", () => {
  it("inspectAccount returns configured when baseUrl, apiBaseUrl, botKey set", () => {
    const cfg = makeCfg({
      baseUrl: "https://sabha.co/1000006",
      apiBaseUrl: "https://sabha.co/1000006/api/bots",
      botKey: "42-AbCdEfGhIjKl",
    });
    const result = sabhaPlugin.config.inspectAccount!(cfg);
    expect(result.configured).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.tokenStatus).toBe("available");
  });

  it("inspectAccount reports missing when unconfigured", () => {
    const result = sabhaPlugin.config.inspectAccount!(makeCfg());
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
  });

  it("inspectAccount reports missing without botKey", () => {
    const cfg = makeCfg({ baseUrl: "https://sabha.co" });
    const result = sabhaPlugin.config.inspectAccount!(cfg);
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
  });

  it("inspectAccount reports missing without apiBaseUrl", () => {
    const cfg = makeCfg({
      baseUrl: "https://sabha.co",
      botKey: "42-AbCdEfGhIjKl",
    });
    const result = sabhaPlugin.config.inspectAccount!(cfg);
    expect(result.configured).toBe(false);
  });
});

describe("sabhaPlugin.capabilities", () => {
  it("advertises expected chat types and features", () => {
    expect(sabhaPlugin.capabilities.chatTypes).toContain("direct");
    expect(sabhaPlugin.capabilities.chatTypes).toContain("group");
    expect(sabhaPlugin.capabilities.chatTypes).toContain("thread");
    expect(sabhaPlugin.capabilities.reactions).toBe(true);
    expect(sabhaPlugin.capabilities.threads).toBe(true);
    expect(sabhaPlugin.capabilities.media).toBe(true);
  });
});

describe("sabhaPlugin.meta", () => {
  it("declares sabha identity", () => {
    expect(sabhaPlugin.meta.id).toBe("sabha");
    expect(sabhaPlugin.meta.label).toBe("Sabha");
  });
});

describe("sabhaPlugin.gateway.startAccount fail-closed paths", () => {
  type CapturedLog = { level: string; message: string };

  // Minimal ctx that exercises the early-return branches without
  // touching monitorSabha. The disabled / wrong-mode branches never
  // reach the "should monitor" block, so cfg / setStatus / channelRuntime
  // don't need real implementations.
  function makeCtx(
    account: ReturnType<typeof resolveBotAccount>,
    logs: CapturedLog[],
    abortSignal: AbortSignal,
  ): Parameters<
    NonNullable<typeof sabhaPlugin.gateway>["startAccount"]
  >[0] {
    const record =
      (level: string) =>
      (message: string): void => {
        logs.push({ level, message });
      };
    return {
      account,
      cfg: makeCfg(),
      abortSignal,
      log: {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
      channelRuntime: undefined,
      setStatus: () => {},
      getStatus: () => ({}),
    } as unknown as Parameters<
      NonNullable<typeof sabhaPlugin.gateway>["startAccount"]
    >[0];
  }

  it("skips disabled accounts without starting a monitor", async () => {
    const account = {
      ...resolveBotAccount({
        cfg: makeCfg({ botAccounts: { default: { baseUrl: "https://x", botKey: "1-a" } } }),
      }),
      enabled: false,
    };
    const logs: CapturedLog[] = [];
    const ac = new AbortController();
    const startPromise = sabhaPlugin.gateway!.startAccount!(
      makeCtx(account, logs, ac.signal),
    );
    ac.abort();
    await startPromise;

    expect(
      logs.some((l) => l.level === "info" && /Disabled/i.test(l.message)),
    ).toBe(true);
    // Must not have logged "Starting WebSocket monitor"
    expect(logs.some((l) => /Starting WebSocket monitor/.test(l.message))).toBe(
      false,
    );
  });

  it("fails closed when a non-default account uses connectionMode webhook", async () => {
    const account = {
      ...resolveBotAccount({
        cfg: makeCfg({
          botAccounts: {
            staging: { baseUrl: "https://x", botKey: "1-a", connectionMode: "webhook" },
          },
        }),
        botAccountId: "staging",
      }),
    };
    const logs: CapturedLog[] = [];
    const ac = new AbortController();
    const startPromise = sabhaPlugin.gateway!.startAccount!(
      makeCtx(account, logs, ac.signal),
    );
    ac.abort();
    await startPromise;

    expect(
      logs.some(
        (l) =>
          l.level === "error" &&
          /webhook/i.test(l.message) &&
          /default bot account/i.test(l.message),
      ),
    ).toBe(true);
    expect(logs.some((l) => /Starting WebSocket monitor/.test(l.message))).toBe(
      false,
    );
  });

  it("allows the default account to run in webhook mode", async () => {
    // Default account + webhook mode is the only supported webhook
    // configuration. It should idle (no error), not fail-close.
    const account = {
      ...resolveBotAccount({
        cfg: makeCfg({
          botAccounts: {
            default: { baseUrl: "https://x", botKey: "1-a", connectionMode: "webhook" },
          },
        }),
      }),
    };
    const logs: CapturedLog[] = [];
    const ac = new AbortController();
    const startPromise = sabhaPlugin.gateway!.startAccount!(
      makeCtx(account, logs, ac.signal),
    );
    ac.abort();
    await startPromise;

    expect(
      logs.some((l) => l.level === "info" && /Webhook mode/.test(l.message)),
    ).toBe(true);
    // No error-level "Webhook mode is only supported" log
    expect(
      logs.some(
        (l) => l.level === "error" && /only supported/.test(l.message),
      ),
    ).toBe(false);
  });
});

describe("sabhaPlugin.status", () => {
  it("buildAccountSnapshot reports configured from account", () => {
    const account = resolveBotAccount({
      cfg: makeCfg({
        botAccounts: {
          default: {
            baseUrl: "https://sabha.co",
            apiBaseUrl: "https://sabha.co/api/bots",
            botKey: "1-abc",
          },
        },
      }),
    });
    const snapshot = sabhaPlugin.status!.buildAccountSnapshot!({
      account,
      cfg: makeCfg(),
      runtime: undefined,
    }) as { configured: boolean; running: boolean };
    expect(snapshot.configured).toBe(true);
    expect(snapshot.running).toBe(false);
  });

  it("buildAccountSnapshot reflects runtime running state", () => {
    const account = resolveBotAccount({
      cfg: makeCfg({ botAccounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    const snapshot = sabhaPlugin.status!.buildAccountSnapshot!({
      account,
      cfg: makeCfg(),
      runtime: {
        accountId: "default",
        running: true,
        lastStartAt: 12345,
      },
    }) as { running: boolean; lastStartAt: number };
    expect(snapshot.running).toBe(true);
    expect(snapshot.lastStartAt).toBe(12345);
  });
});
