import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  listBotAccountIds,
  listEnabledBotAccounts,
  resolveBotAccount,
  resolveBotAccountForSdk,
  resolveDefaultBotAccountId,
} from "./bot-accounts.js";

function cfg(sabha: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("listBotAccountIds", () => {
  it("returns a sorted list when botAccounts is populated", () => {
    const ids = listBotAccountIds(
      cfg({
        baseUrl: "https://sabha.example",
        botAccounts: {
          staging: { botKey: "2-bbb" },
          production: { botKey: "3-ccc" },
        },
      }),
    );
    expect(ids).toEqual(["production", "staging"]);
  });

  it("returns an empty list when botAccounts is empty", () => {
    const ids = listBotAccountIds(
      cfg({ baseUrl: "x", botAccounts: {} }),
    );
    expect(ids).toEqual([]);
  });

  it("returns an empty list when channels.sabha is missing", () => {
    expect(listBotAccountIds({} as OpenClawConfig)).toEqual([]);
  });
});

describe("resolveDefaultBotAccountId", () => {
  it("uses defaultBotAccount override when set and listed", () => {
    const id = resolveDefaultBotAccountId(
      cfg({
        baseUrl: "x",
        botKey: "1-a",
        botAccounts: {
          production: { botKey: "2-bbb" },
          staging: { botKey: "3-ccc" },
        },
        defaultBotAccount: "staging",
      }),
    );
    expect(id).toBe("staging");
  });

  it("falls back to the alphabetic-first account", () => {
    const id = resolveDefaultBotAccountId(
      cfg({
        baseUrl: "x",
        botKey: "1-a",
        botAccounts: {
          staging: { botKey: "2-b" },
          production: { botKey: "3-c" },
        },
      }),
    );
    expect(id).toBe("production");
  });

  it("returns the alphabetic-first when no override and single account", () => {
    expect(
      resolveDefaultBotAccountId(
        cfg({ botAccounts: { primary: { baseUrl: "x", botKey: "1-a" } } }),
      ),
    ).toBe("primary");
  });
});

describe("resolveBotAccount", () => {
  it("resolves a bot account from botAccounts map", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        botAccounts: {
          default: {
            baseUrl: "https://sabha.co/1000006",
            botKey: "42-BaseKey",
            botName: "BaseBot",
          },
        },
      }),
    });
    expect(account.accountId).toBe("default");
    expect(account.baseUrl).toBe("https://sabha.co/1000006");
    expect(account.botKey).toBe("42-BaseKey");
    expect(account.botId).toBe(42);
    expect(account.botName).toBe("BaseBot");
    expect(account.enabled).toBe(true);
  });

  it("layers per-bot overrides onto the base", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        baseUrl: "https://sabha.co/base",
        botKey: "1-base",
        botName: "BaseBot",
        typingEnabled: false,
        botAccounts: {
          staging: {
            baseUrl: "https://sabha.co/staging",
            botKey: "99-StagingKey",
            botName: "StagingBot",
          },
        },
      }),
      botAccountId: "staging",
    });
    expect(account.accountId).toBe("staging");
    expect(account.baseUrl).toBe("https://sabha.co/staging");
    expect(account.botKey).toBe("99-StagingKey");
    expect(account.botId).toBe(99);
    expect(account.botName).toBe("StagingBot");
    // inherited from base because staging doesn't override it
    expect(account.typingEnabled).toBe(false);
  });

  it("defaults connectionMode to websocket", () => {
    const account = resolveBotAccount({
      cfg: cfg({ botAccounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    expect(account.connectionMode).toBe("websocket");
  });

  it("treats base enabled: false as disabled for every bot account", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        enabled: false,
        baseUrl: "x",
        botKey: "1-a",
        botAccounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
        },
      }),
      botAccountId: "staging",
    });
    expect(account.enabled).toBe(false);
  });

  it("treats per-bot enabled: false as disabled even when base is enabled", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        botAccounts: {
          staging: { enabled: false, baseUrl: "y", botKey: "2-b" },
        },
      }),
      botAccountId: "staging",
    });
    expect(account.enabled).toBe(false);
  });

  it("defaults to the resolved default bot account when id is omitted", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        botAccounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
          production: { baseUrl: "z", botKey: "3-c" },
        },
        defaultBotAccount: "production",
      }),
    });
    expect(account.accountId).toBe("production");
    expect(account.baseUrl).toBe("z");
  });

  it("layers per-bot allowFrom over the base (override wins on arrays)", () => {
    // Arrays are replaced by the override, not merged — this is the
    // SDK's mergeAccountConfig semantics (spread, not deep-merge). It
    // matters because a production bot may need a stricter allowlist
    // than the shared base default.
    const base = resolveBotAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        allowFrom: ["100", "101"],
        botAccounts: {
          production: {
            baseUrl: "y",
            botKey: "2-b",
            allowFrom: ["999"],
          },
          staging: { baseUrl: "z", botKey: "3-c" },
        },
      }),
      botAccountId: "production",
    });
    expect(base.allowFrom).toEqual(["999"]);

    // Staging has no override — inherits the base allowFrom.
    const staging = resolveBotAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        allowFrom: ["100", "101"],
        botAccounts: {
          production: { baseUrl: "y", botKey: "2-b", allowFrom: ["999"] },
          staging: { baseUrl: "z", botKey: "3-c" },
        },
      }),
      botAccountId: "staging",
    });
    expect(staging.allowFrom).toEqual(["100", "101"]);
  });

  it("layers per-bot dmPolicy over the base", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        dmPolicy: "open",
        botAccounts: {
          production: {
            baseUrl: "y",
            botKey: "2-b",
            dmPolicy: "allowlist",
          },
        },
      }),
      botAccountId: "production",
    });
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("defaults replyToMode to first", () => {
    const account = resolveBotAccount({
      cfg: cfg({ botAccounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    expect(account.replyToMode).toBe("first");
  });

  it("respects explicit replyToMode from base config", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        replyToMode: "all",
        botAccounts: { default: { baseUrl: "x", botKey: "1-a" } },
      }),
    });
    expect(account.replyToMode).toBe("all");
  });

  it("layers per-bot replyToMode over the base", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        replyToMode: "first",
        botAccounts: {
          production: { baseUrl: "y", botKey: "2-b", replyToMode: "off" },
        },
      }),
      botAccountId: "production",
    });
    expect(account.replyToMode).toBe("off");
  });

  it("defaults rooms to an empty map", () => {
    const account = resolveBotAccount({
      cfg: cfg({ botAccounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    expect(account.rooms).toEqual({});
  });

  it("resolves rooms from base config", () => {
    const account = resolveBotAccount({
      cfg: cfg({
        rooms: { "42": { systemPrompt: "Be formal." } },
        botAccounts: { default: { baseUrl: "x", botKey: "1-a" } },
      }),
    });
    expect(account.rooms).toEqual({ "42": { systemPrompt: "Be formal." } });
  });

  it("does not leak the botAccounts map into the merged config", () => {
    // Regression guard: if we forget to omit `botAccounts` from the base
    // during merge, the field leaks into every resolved account's shape.
    const account = resolveBotAccount({
      cfg: cfg({
        botAccounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
        },
      }),
      botAccountId: "staging",
    });
    expect((account as unknown as { botAccounts?: unknown }).botAccounts).toBeUndefined();
  });
});

describe("resolveBotAccountForSdk", () => {
  it("forwards accountId through to resolveBotAccount", () => {
    const account = resolveBotAccountForSdk(
      cfg({
        botAccounts: { staging: { baseUrl: "y", botKey: "2-b" } },
      }),
      "staging",
    );
    expect(account.accountId).toBe("staging");
    expect(account.baseUrl).toBe("y");
  });

  it("handles nullish accountId by resolving the default", () => {
    const account = resolveBotAccountForSdk(
      cfg({ botAccounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
      null,
    );
    expect(account.accountId).toBe("default");
  });
});

describe("listEnabledBotAccounts", () => {
  it("returns every enabled bot account", () => {
    const accounts = listEnabledBotAccounts(
      cfg({
        botAccounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
          production: { baseUrl: "z", botKey: "3-c" },
        },
      }),
    );
    expect(accounts.map((a) => a.accountId).sort()).toEqual([
      "production",
      "staging",
    ]);
  });

  it("filters out disabled bot accounts", () => {
    const accounts = listEnabledBotAccounts(
      cfg({
        botAccounts: {
          staging: { enabled: false, baseUrl: "y", botKey: "2-b" },
          production: { baseUrl: "z", botKey: "3-c" },
        },
      }),
    );
    expect(accounts.map((a) => a.accountId)).toEqual(["production"]);
  });
});
