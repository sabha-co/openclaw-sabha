import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";
import {
  deriveCableUrl,
  inspectSabhaAccount,
  listSabhaAccountIds,
  normalizeCableUrl,
  normalizeWorkspaceUrl,
  patchSabhaAccount,
  resolveDefaultSabhaAccountId,
  resolveSabhaAccount,
} from "./accounts.js";
import { SabhaChannelSchema } from "./schema.js";

const KEY = "sabha_app_0123456789abcdef0123456789abcdef";
const cfg = (sabha: unknown) => ({ channels: { sabha } }) as unknown as OpenClawConfig;

describe("workspace URLs", () => {
  it("normalizes and rejects non-http URLs", () => {
    expect(normalizeWorkspaceUrl(" https://sabha.co/1000006/ ")).toBe("https://sabha.co/1000006");
    expect(normalizeWorkspaceUrl("https://chat.example.test/?x=1#y")).toBe("https://chat.example.test");
    expect(normalizeWorkspaceUrl("ftp://x")).toBe("");
    expect(normalizeWorkspaceUrl("not a url")).toBe("");
  });

  it("accepts the API base URL the app page shows", () => {
    expect(normalizeWorkspaceUrl("https://sabha.co/1000006/api/v1")).toBe("https://sabha.co/1000006");
    expect(normalizeWorkspaceUrl("https://chat.example.test/api/v1/")).toBe("https://chat.example.test");
  });

  it("accepts the app page's WebSocket URL, dropping its key", () => {
    expect(normalizeCableUrl("wss://chat.example.test/cable?bot_key=sabha_app_x")).toBe("wss://chat.example.test/cable");
    expect(normalizeCableUrl("https://sabha.co/cable?wid=1000006&bot_key=k")).toBe("wss://sabha.co/cable?wid=1000006");
    expect(normalizeCableUrl("ftp://x")).toBe("");
  });

  it("puts the sabha.co workspace in ?wid=, never under the path prefix", () => {
    expect(deriveCableUrl("https://sabha.co/1000006")).toBe("wss://sabha.co/cable?wid=1000006");
  });

  it("keeps self-hosted cables at /cable on the same host", () => {
    expect(deriveCableUrl("https://chat.example.test")).toBe("wss://chat.example.test/cable");
    expect(deriveCableUrl("http://localhost:3000")).toBe("ws://localhost:3000/cable");
  });
});

describe("resolveSabhaAccount", () => {
  it("layers the named account over shared root settings", () => {
    const account = resolveSabhaAccount(
      cfg({ url: "https://sabha.co/1000006", replyToMode: "off", accounts: { default: { appKey: KEY } } }),
      "default",
    );
    expect(account).toMatchObject({
      configured: true,
      url: "https://sabha.co/1000006",
      apiBaseUrl: "https://sabha.co/1000006/api/v1",
      cableUrl: "wss://sabha.co/cable?wid=1000006",
      replyToMode: "off",
      dmPolicy: "open",
      livePreview: true,
    });
  });

  it("never treats an unlisted account as configured", () => {
    const account = resolveSabhaAccount(cfg({ url: "https://sabha.co/1000006", accounts: { a: { appKey: KEY } } }), "b");
    expect(account.configured).toBe(false);
    expect(account.url).toBe("");
  });

  it("honours an explicit cable override and defaultAccount", () => {
    const config = cfg({
      defaultAccount: "dev",
      accounts: { dev: { url: "http://localhost:3000", appKey: KEY, cableUrl: "ws://localhost:8080/cable" }, z: {} },
    });
    expect(resolveDefaultSabhaAccountId(config)).toBe("dev");
    expect(resolveSabhaAccount(config).cableUrl).toBe("ws://localhost:8080/cable");
    expect(listSabhaAccountIds(config)).toEqual(["dev", "z"]);
  });

  it("disables every account when the channel is disabled", () => {
    expect(resolveSabhaAccount(cfg({ enabled: false, accounts: { default: { url: "https://x.test", appKey: KEY } } })).enabled).toBe(false);
  });
});

describe("schema", () => {
  it("rejects credentials at the channel root", () => {
    expect(SabhaChannelSchema.safeParse({ appKey: KEY }).success).toBe(false);
    expect(SabhaChannelSchema.safeParse({ url: "https://x.test", accounts: { a: { appKey: KEY } } }).success).toBe(true);
  });
});

describe("inspectSabhaAccount", () => {
  it("reports credential status without exposing the key", () => {
    const inspected = inspectSabhaAccount(cfg({ accounts: { default: { url: "https://x.test", appKey: KEY } } }));
    expect(inspected).toMatchObject({ configured: true, tokenStatus: "available", tokenSource: "config" });
    expect(JSON.stringify(inspected)).not.toContain(KEY);
    expect(inspectSabhaAccount(cfg({ accounts: { default: { appKey: "" } } })).tokenStatus).toBe("configured_unavailable");
  });
});

describe("patchSabhaAccount", () => {
  it("writes the named-account shape and keeps siblings", () => {
    const next = patchSabhaAccount(cfg({ accounts: { other: { appKey: KEY } } }), "Default", { url: "https://x.test" });
    expect((next.channels as Record<string, unknown>).sabha).toEqual({
      accounts: { other: { appKey: KEY }, default: { url: "https://x.test", enabled: true } },
    });
  });
});
