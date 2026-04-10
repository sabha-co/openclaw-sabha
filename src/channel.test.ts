import { describe, it, expect } from "vitest";
import { sabhaPlugin, resolveAccount } from "./channel.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function makeCfg(sabha?: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("resolveAccount", () => {
  it("resolves from config", () => {
    const cfg = makeCfg({
      baseUrl: "https://sabha.co/1000006",
      botKey: "42-AbCdEfGhIjKl",
    });
    const account = resolveAccount(cfg);
    expect(account.baseUrl).toBe("https://sabha.co/1000006");
    expect(account.botKey).toBe("42-AbCdEfGhIjKl");
    expect(account.botId).toBe(42);
  });

  it("defaults connectionMode to websocket", () => {
    const cfg = makeCfg({
      baseUrl: "https://chat.example.com",
      botKey: "1-xyz",
    });
    expect(resolveAccount(cfg).connectionMode).toBe("websocket");
  });

  it("respects explicit webhook connectionMode", () => {
    const cfg = makeCfg({
      baseUrl: "https://chat.example.com",
      botKey: "1-xyz",
      connectionMode: "webhook",
    });
    expect(resolveAccount(cfg).connectionMode).toBe("webhook");
  });

  it("defaults dmPolicy to open", () => {
    const cfg = makeCfg({ baseUrl: "x", botKey: "1-a" });
    expect(resolveAccount(cfg).dmPolicy).toBe("open");
  });

  it("returns empty strings for missing config", () => {
    const account = resolveAccount(makeCfg());
    expect(account.baseUrl).toBe("");
    expect(account.botKey).toBe("");
    expect(account.botId).toBe(0);
  });
});

describe("sabhaPlugin.config", () => {
  it("inspectAccount returns configured when baseUrl and botKey set", () => {
    const cfg = makeCfg({
      baseUrl: "https://sabha.co/1000006",
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

describe("sabhaPlugin.status", () => {
  it("buildAccountSnapshot reports configured from account", () => {
    const account = resolveAccount(
      makeCfg({ baseUrl: "https://sabha.co", botKey: "1-abc" }),
    );
    const snapshot = sabhaPlugin.status!.buildAccountSnapshot!({
      account,
      cfg: makeCfg(),
      runtime: undefined,
    }) as { configured: boolean; running: boolean };
    expect(snapshot.configured).toBe(true);
    expect(snapshot.running).toBe(false);
  });

  it("buildAccountSnapshot reflects runtime running state", () => {
    const account = resolveAccount(
      makeCfg({ baseUrl: "x", botKey: "1-a" }),
    );
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
