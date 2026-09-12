import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  listSabhaAccountIds,
  listConfiguredSabhaAccountIds,
  listEnabledSabhaAccounts,
  resolveSabhaAccount,
  resolveSabhaAccountForSdk,
  resolveDefaultSabhaAccountId,
} from "./accounts.js";

function cfg(sabha: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("listSabhaAccountIds", () => {
  it("returns a sorted list when accounts is populated", () => {
    const ids = listSabhaAccountIds(
      cfg({
        baseUrl: "https://sabha.example",
        accounts: {
          staging: { botKey: "2-bbb" },
          production: { botKey: "3-ccc" },
        },
      }),
    );
    expect(ids).toEqual(["production", "staging"]);
  });

  it("returns no accounts when accounts is empty", () => {
    const ids = listSabhaAccountIds(cfg({ baseUrl: "x", accounts: {} }));
    expect(ids).toEqual([]);
  });

  it("returns no accounts when channels.sabha is missing", () => {
    expect(listSabhaAccountIds({} as OpenClawConfig)).toEqual([]);
  });
});

describe("listConfiguredSabhaAccountIds", () => {
  it("only includes explicitly-configured account ids", () => {
    const ids = listConfiguredSabhaAccountIds(
      cfg({
        baseUrl: "x",
        accounts: {
          staging: { botKey: "2-b" },
          production: { botKey: "3-c" },
        },
      }),
    );
    expect(ids.sort()).toEqual(["production", "staging"]);
  });

  it("returns [] when no explicit accounts entries exist (no SDK fallback)", () => {
    expect(listConfiguredSabhaAccountIds(cfg({ baseUrl: "x" }))).toEqual([]);
  });
});

describe("resolveDefaultSabhaAccountId", () => {
  it("uses defaultAccount override when set and listed", () => {
    const id = resolveDefaultSabhaAccountId(
      cfg({
        baseUrl: "x",
        botKey: "1-a",
        accounts: {
          production: { botKey: "2-bbb" },
          staging: { botKey: "3-ccc" },
        },
        defaultAccount: "staging",
      }),
    );
    expect(id).toBe("staging");
  });

  it("falls back to the alphabetic-first account", () => {
    const id = resolveDefaultSabhaAccountId(
      cfg({
        baseUrl: "x",
        botKey: "1-a",
        accounts: {
          staging: { botKey: "2-b" },
          production: { botKey: "3-c" },
        },
      }),
    );
    expect(id).toBe("production");
  });

  it("returns the alphabetic-first when no override and single account", () => {
    expect(
      resolveDefaultSabhaAccountId(
        cfg({ accounts: { primary: { baseUrl: "x", botKey: "1-a" } } }),
      ),
    ).toBe("primary");
  });
});

describe("resolveSabhaAccount", () => {
  it("resolves mixed-case named accounts through canonical ids without inheriting root credentials", () => {
    const config = cfg({
      baseUrl: "https://sabha.example", botKey: "1-root", botName: "Root", websocketUrl: "wss://root/cable",
      accounts: { Backup: { botKey: "7-backup" }, Primary: { botKey: "42-primary" } },
      defaultAccount: "Primary",
    });
    expect(listSabhaAccountIds(config)).toEqual(["backup", "primary"]);
    expect(resolveDefaultSabhaAccountId(config)).toBe("primary");
    for (const accountId of [undefined, "Primary", "primary"]) {
      expect(resolveSabhaAccount({ cfg: config, accountId })).toMatchObject({
        accountId: "primary", botKey: "42-primary", baseUrl: "https://sabha.example", botName: "OpenClaw", websocketUrl: "",
      });
    }
    expect(resolveSabhaAccount({ cfg: config, accountId: "missing" }).botKey).toBe("");
  });
  it("resolves an account from the accounts map", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        accounts: {
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

  it("layers per-account overrides onto the base", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        baseUrl: "https://sabha.co/base",
        botKey: "1-base",
        botName: "BaseBot",
        typingEnabled: false,
        accounts: {
          staging: {
            baseUrl: "https://sabha.co/staging",
            botKey: "99-StagingKey",
            botName: "StagingBot",
          },
        },
      }),
      accountId: "staging",
    });
    expect(account.accountId).toBe("staging");
    expect(account.baseUrl).toBe("https://sabha.co/staging");
    expect(account.botKey).toBe("99-StagingKey");
    expect(account.botId).toBe(99);
    expect(account.botName).toBe("StagingBot");
    // inherited from base because staging doesn't override it
    expect(account.typingEnabled).toBe(false);
  });

  it("treats base enabled: false as disabled for every account", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        enabled: false,
        baseUrl: "x",
        botKey: "1-a",
        accounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
        },
      }),
      accountId: "staging",
    });
    expect(account.enabled).toBe(false);
  });

  it("treats per-account enabled: false as disabled even when base is enabled", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        accounts: {
          staging: { enabled: false, baseUrl: "y", botKey: "2-b" },
        },
      }),
      accountId: "staging",
    });
    expect(account.enabled).toBe(false);
  });

  it("defaults to the resolved default account when id is omitted", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        accounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
          production: { baseUrl: "z", botKey: "3-c" },
        },
        defaultAccount: "production",
      }),
    });
    expect(account.accountId).toBe("production");
    expect(account.baseUrl).toBe("z");
  });

  it("layers per-account allowFrom over the base (override wins on arrays)", () => {
    // Arrays are replaced by the override, not merged — this is the
    // SDK's mergeAccountConfig semantics (spread, not deep-merge). It
    // matters because a production account may need a stricter allowlist
    // than the shared base default.
    const base = resolveSabhaAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        allowFrom: ["100", "101"],
        accounts: {
          production: {
            baseUrl: "y",
            botKey: "2-b",
            allowFrom: ["999"],
          },
          staging: { baseUrl: "z", botKey: "3-c" },
        },
      }),
      accountId: "production",
    });
    expect(base.allowFrom).toEqual(["999"]);

    // Staging has no override — inherits the base allowFrom.
    const staging = resolveSabhaAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        allowFrom: ["100", "101"],
        accounts: {
          production: { baseUrl: "y", botKey: "2-b", allowFrom: ["999"] },
          staging: { baseUrl: "z", botKey: "3-c" },
        },
      }),
      accountId: "staging",
    });
    expect(staging.allowFrom).toEqual(["100", "101"]);
  });

  it("layers per-account dmPolicy over the base", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        baseUrl: "x",
        botKey: "1-a",
        dmPolicy: "open",
        accounts: {
          production: {
            baseUrl: "y",
            botKey: "2-b",
            dmPolicy: "allowlist",
          },
        },
      }),
      accountId: "production",
    });
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("defaults replyToMode to first", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({ accounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    expect(account.replyToMode).toBe("first");
  });

  it("respects explicit replyToMode from base config", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        replyToMode: "all",
        accounts: { default: { baseUrl: "x", botKey: "1-a" } },
      }),
    });
    expect(account.replyToMode).toBe("all");
  });

  it("layers per-account replyToMode over the base", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        replyToMode: "first",
        accounts: {
          production: { baseUrl: "y", botKey: "2-b", replyToMode: "off" },
        },
      }),
      accountId: "production",
    });
    expect(account.replyToMode).toBe("off");
  });

  it("defaults rooms to an empty map", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({ accounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
    });
    expect(account.rooms).toEqual({});
  });

  it("resolves rooms from base config", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        rooms: { "42": { systemPrompt: "Be formal." } },
        accounts: { default: { baseUrl: "x", botKey: "1-a" } },
      }),
    });
    expect(account.rooms).toEqual({ "42": { systemPrompt: "Be formal." } });
  });

  it("does not leak the accounts map into the merged config", () => {
    // Regression guard: if we forget to omit `accounts` from the base
    // during merge, the field leaks into every resolved account's shape.
    const account = resolveSabhaAccount({
      cfg: cfg({
        accounts: {
          staging: { baseUrl: "y", botKey: "2-b" },
        },
      }),
      accountId: "staging",
    });
    expect((account as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it("does not leak defaultAccount into the merged config", () => {
    const account = resolveSabhaAccount({
      cfg: cfg({
        accounts: { staging: { baseUrl: "y", botKey: "2-b" } },
        defaultAccount: "staging",
      }),
      accountId: "staging",
    });
    expect(
      (account as unknown as { defaultAccount?: unknown }).defaultAccount,
    ).toBeUndefined();
  });
});

describe("resolveSabhaAccountForSdk", () => {
  it("forwards accountId through to resolveSabhaAccount", () => {
    const account = resolveSabhaAccountForSdk(
      cfg({
        accounts: { staging: { baseUrl: "y", botKey: "2-b" } },
      }),
      "staging",
    );
    expect(account.accountId).toBe("staging");
    expect(account.baseUrl).toBe("y");
  });

  it("handles nullish accountId by resolving the default", () => {
    const account = resolveSabhaAccountForSdk(
      cfg({ accounts: { default: { baseUrl: "x", botKey: "1-a" } } }),
      null,
    );
    expect(account.accountId).toBe("default");
  });
});

describe("listEnabledSabhaAccounts", () => {
  it("returns every enabled account", () => {
    const accounts = listEnabledSabhaAccounts(
      cfg({
        accounts: {
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

  it("filters out disabled accounts", () => {
    const accounts = listEnabledSabhaAccounts(
      cfg({
        accounts: {
          staging: { enabled: false, baseUrl: "y", botKey: "2-b" },
          production: { baseUrl: "z", botKey: "3-c" },
        },
      }),
    );
    expect(accounts.map((a) => a.accountId)).toEqual(["production"]);
  });
});
