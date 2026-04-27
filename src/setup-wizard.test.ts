import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  getSabhaAccountView,
  isDefaultSabhaAccount,
  listConfiguredSabhaAccountIds,
  sabhaSetupWizard,
  setSabhaAccountConfig,
} from "./setup-wizard.js";

type Cfg = OpenClawConfig;

const emptyCfg: Cfg = { channels: {} } as Cfg;

const singleBotCfg: Cfg = {
  channels: {
    sabha: {
      accounts: {
        default: {
          baseUrl: "https://sabha.example.com",
          apiBaseUrl: "https://sabha.example.com/api/bots",
          botKey: "42-default",
          botName: "Default Bot",
          dmPolicy: "open",
        },
      },
    },
  },
} as unknown as Cfg;

const multiCfg: Cfg = {
  channels: {
    sabha: {
      baseUrl: "https://sabha.example.com",
      apiBaseUrl: "https://sabha.example.com/api/bots",
      accounts: {
        default: {
          baseUrl: "https://sabha.example.com",
          apiBaseUrl: "https://sabha.example.com/api/bots",
          botKey: "42-default",
          botName: "Default Bot",
        },
        staging: {
          baseUrl: "https://staging.sabha.example.com",
          apiBaseUrl: "https://staging.sabha.example.com/api/bots",
          botKey: "17-staging",
          botName: "Staging Bot",
        },
      },
    },
  },
} as unknown as Cfg;

describe("isDefaultSabhaAccount", () => {
  it("treats undefined and null as the default account", () => {
    expect(isDefaultSabhaAccount(undefined)).toBe(true);
    expect(isDefaultSabhaAccount(null)).toBe(true);
    expect(isDefaultSabhaAccount("")).toBe(true);
  });

  it("recognizes the canonical default id", () => {
    expect(isDefaultSabhaAccount("default")).toBe(true);
  });

  it("returns false for named accounts", () => {
    expect(isDefaultSabhaAccount("staging")).toBe(false);
    expect(isDefaultSabhaAccount("prod-eu")).toBe(false);
  });
});

describe("getSabhaAccountView", () => {
  it("reads the default account from accounts", () => {
    const view = getSabhaAccountView(singleBotCfg, undefined);
    expect(view.baseUrl).toBe("https://sabha.example.com");
    expect(view.botKey).toBe("42-default");
  });

  it("returns an empty view when nothing is configured", () => {
    const view = getSabhaAccountView(emptyCfg, undefined);
    expect(view.baseUrl).toBeUndefined();
    expect(view.botKey).toBeUndefined();
  });

  it("layers a named account on top of the base", () => {
    const view = getSabhaAccountView(multiCfg, "staging");
    // Override wins for fields set in the named entry
    expect(view.baseUrl).toBe("https://staging.sabha.example.com");
    expect(view.botKey).toBe("17-staging");
    expect(view.botName).toBe("Staging Bot");
  });

  it("still returns the default account values when named accounts exist", () => {
    const view = getSabhaAccountView(multiCfg, undefined);
    expect(view.baseUrl).toBe("https://sabha.example.com");
    expect(view.botKey).toBe("42-default");
  });
});

describe("setSabhaAccountConfig", () => {
  it("writes the default account into accounts.default", () => {
    const next = setSabhaAccountConfig(emptyCfg, undefined, {
      baseUrl: "https://chat.example.com",
      botKey: "5-new",
      botName: "New",
    });
    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    const accounts = section.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.default.baseUrl).toBe("https://chat.example.com");
    expect(accounts.default.botKey).toBe("5-new");
    expect(accounts.default.enabled).toBe(true);
  });

  it("writes a named account under accounts.<id> without clobbering other accounts", () => {
    const next = setSabhaAccountConfig(singleBotCfg, "staging", {
      baseUrl: "https://staging.sabha.example.com",
      botKey: "17-staging",
      botName: "Staging Bot",
    });

    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;

    // Existing default account is preserved
    const accounts = section.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.default.botKey).toBe("42-default");

    // Named account is nested under accounts
    expect(accounts.staging.baseUrl).toBe("https://staging.sabha.example.com");
    expect(accounts.staging.botKey).toBe("17-staging");
    expect(accounts.staging.enabled).toBe(true);
  });

  it("edits an existing named account in place", () => {
    const next = setSabhaAccountConfig(multiCfg, "staging", {
      botName: "Staging Bot v2",
    });
    const accounts = (
      (next.channels as Record<string, unknown>).sabha as Record<string, unknown>
    ).accounts as Record<string, Record<string, unknown>>;
    // Patched field updated; untouched fields preserved
    expect(accounts.staging.botName).toBe("Staging Bot v2");
    expect(accounts.staging.baseUrl).toBe(
      "https://staging.sabha.example.com",
    );
    expect(accounts.staging.botKey).toBe("17-staging");
  });

  it("normalizes whitespace / case on the named-account id", () => {
    const next = setSabhaAccountConfig(emptyCfg, "  Staging  ", {
      baseUrl: "x",
      botKey: "1-x",
    });
    const accounts = (
      (next.channels as Record<string, unknown>).sabha as Record<string, unknown>
    ).accounts as Record<string, unknown>;
    // normalizeAccountId lowercases + trims
    expect(Object.keys(accounts)).toEqual(["staging"]);
  });
});

describe("sabhaSetupWizard.status.resolveConfigured", () => {
  const resolveConfigured = sabhaSetupWizard.status.resolveConfigured;

  it("returns true for the default account on a single-bot config", () => {
    expect(resolveConfigured({ cfg: singleBotCfg, accountId: undefined })).toBe(
      true,
    );
  });

  it("returns false on an empty config", () => {
    expect(resolveConfigured({ cfg: emptyCfg, accountId: undefined })).toBe(
      false,
    );
  });

  it("returns true for a named account that has both baseUrl and botKey", () => {
    expect(resolveConfigured({ cfg: multiCfg, accountId: "staging" })).toBe(
      true,
    );
  });

  it("returns true for the default on a multi-account config (base still has credentials)", () => {
    expect(resolveConfigured({ cfg: multiCfg, accountId: undefined })).toBe(
      true,
    );
  });

  it("returns false for an unknown account id", () => {
    expect(resolveConfigured({ cfg: multiCfg, accountId: "prod" })).toBe(false);
  });
});

describe("listConfiguredSabhaAccountIds", () => {
  it("returns an empty list when nothing is configured", () => {
    expect(listConfiguredSabhaAccountIds(emptyCfg)).toEqual([]);
  });

  it("returns the default id for a single-bot config", () => {
    expect(listConfiguredSabhaAccountIds(singleBotCfg)).toEqual(["default"]);
  });

  it("returns every named account plus the default when all have credentials", () => {
    const ids = listConfiguredSabhaAccountIds(multiCfg);
    expect(ids).toEqual(expect.arrayContaining(["default", "staging"]));
    expect(ids.length).toBe(2);
  });

  it("omits a named account with only a partial override (no botKey)", () => {
    const cfg: Cfg = {
      channels: {
        sabha: {
          baseUrl: "https://sabha.example.com",
          apiBaseUrl: "https://sabha.example.com/api/bots",
          accounts: {
            default: { botKey: "42-x" },
            partial: { botName: "Half Baked" }, // no botKey of its own
          },
        },
      },
    } as unknown as Cfg;
    // `partial` inherits baseUrl + apiBaseUrl from the base section but
    // has no botKey (botKey lives in accounts.default, not at the base
    // level), so it does not appear as configured.
    expect(listConfiguredSabhaAccountIds(cfg)).toEqual(["default"]);
  });
});

describe("sabhaSetupWizard.resolveAccountIdForConfigure", () => {
  const resolve = sabhaSetupWizard.resolveAccountIdForConfigure!;

  function stubPrompter(
    recorded: {
      selectCalls: number;
      textCalls: number;
      selectAnswer?: string;
      textAnswer?: string;
    },
  ) {
    return {
      select: async (_opts: { options: Array<{ value: string }> }) => {
        recorded.selectCalls += 1;
        return recorded.selectAnswer ?? _opts.options[0]!.value;
      },
      text: async (_opts: { validate?: (value: string) => string | undefined }) => {
        recorded.textCalls += 1;
        const answer = recorded.textAnswer ?? "analyst";
        const err = _opts.validate?.(answer);
        if (err) throw new Error(`text validation failed: ${err}`);
        return answer;
      },
      // Unused methods for this suite — fail loudly if something calls
      // them so a future code change doesn't silently bypass the flow.
      confirm: async () => {
        throw new Error("confirm should not be called by resolveAccountIdForConfigure");
      },
      note: async () => {
        recorded.noteCalls = (recorded.noteCalls ?? 0) + 1;
      },
      progress: () => {
        throw new Error("progress should not be called by resolveAccountIdForConfigure");
      },
    } as unknown as Parameters<typeof resolve>[0]["prompter"];
  }

  // The SDK passes this helper through to resolveAccountIdForConfigure,
  // but our wizard implementation never calls it — we use
  // `listConfiguredSabhaAccountIds` directly. Return a stub so the typed
  // signature is happy.
  const listAccountIds = (_cfg: Cfg) => ["default"];

  it("honors an explicit accountOverride without prompting", async () => {
    const recorded = { selectCalls: 0, textCalls: 0 };
    const prompter = stubPrompter(recorded);
    const result = await resolve({
      cfg: multiCfg,
      prompter,
      accountOverride: "staging",
      defaultAccountId: "default",
      shouldPromptAccountIds: false,
      listAccountIds,
    });
    expect(result).toBe("staging");
    expect(recorded.selectCalls).toBe(0);
    expect(recorded.textCalls).toBe(0);
  });

  it("falls through to defaultAccountId on a fresh config with nothing configured", async () => {
    const recorded = { selectCalls: 0, textCalls: 0 };
    const prompter = stubPrompter(recorded);
    const result = await resolve({
      cfg: emptyCfg,
      prompter,
      defaultAccountId: "default",
      shouldPromptAccountIds: false,
      listAccountIds,
    });
    expect(result).toBe("default");
    expect(recorded.selectCalls).toBe(0);
  });

  it("offers Edit options when at least one bot is configured and returns the picked id", async () => {
    const recorded = {
      selectCalls: 0,
      textCalls: 0,
      selectAnswer: "edit:staging",
    };
    const prompter = stubPrompter(recorded);
    const result = await resolve({
      cfg: multiCfg,
      prompter,
      defaultAccountId: "default",
      shouldPromptAccountIds: false,
      listAccountIds,
    });
    expect(result).toBe("staging");
    expect(recorded.selectCalls).toBe(1);
    expect(recorded.textCalls).toBe(0);
  });

  it("prompts for a name and derives the account id when the user picks Add new bot", async () => {
    const recorded = {
      selectCalls: 0,
      textCalls: 0,
      selectAnswer: "new",
      textAnswer: "Analyst",
    };
    const prompter = stubPrompter(recorded);
    const result = await resolve({
      cfg: multiCfg,
      prompter,
      defaultAccountId: "default",
      shouldPromptAccountIds: false,
      listAccountIds,
    });
    expect(result).toBe("analyst");
    expect(recorded.selectCalls).toBe(1);
    expect(recorded.textCalls).toBe(1);
  });

  it("shows a note when the derived id differs from the entered name", async () => {
    const recorded = {
      selectCalls: 0,
      textCalls: 0,
      noteCalls: 0,
      selectAnswer: "new",
      textAnswer: "My Analyst Bot",
    };
    const prompter = stubPrompter(recorded);
    const result = await resolve({
      cfg: multiCfg,
      prompter,
      defaultAccountId: "default",
      shouldPromptAccountIds: false,
      listAccountIds,
    });
    expect(result).toBe("my-analyst-bot");
    expect(recorded.noteCalls).toBe(1);
  });

  it("rejects reserved and duplicate names via the text validator", async () => {
    // Simulate the `default` case — validator must reject.
    const reserved = { selectCalls: 0, textCalls: 0, selectAnswer: "new", textAnswer: "default" };
    await expect(
      resolve({
        cfg: multiCfg,
        prompter: stubPrompter(reserved),
        defaultAccountId: "default",
        shouldPromptAccountIds: false,
        listAccountIds,
      }),
    ).rejects.toThrow(/reserved/);

    // And the duplicate case — `staging` is already in multiCfg.
    const duplicate = { selectCalls: 0, textCalls: 0, selectAnswer: "new", textAnswer: "staging" };
    await expect(
      resolve({
        cfg: multiCfg,
        prompter: stubPrompter(duplicate),
        defaultAccountId: "default",
        shouldPromptAccountIds: false,
        listAccountIds,
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("sabhaSetupWizard.dmPolicy", () => {
  const dmPolicy = sabhaSetupWizard.dmPolicy!;

  it("getCurrent honors accountId", () => {
    const cfg: Cfg = {
      channels: {
        sabha: {
          baseUrl: "https://sabha.example.com",
          apiBaseUrl: "https://sabha.example.com/api/bots",
          accounts: {
            default: { botKey: "42-x", dmPolicy: "open" },
            staging: { dmPolicy: "allowlist" },
          },
        },
      },
    } as unknown as Cfg;

    expect(dmPolicy.getCurrent(cfg, undefined)).toBe("open");
    expect(dmPolicy.getCurrent(cfg, "staging")).toBe("allowlist");
  });

  it("setPolicy writes to the named account without clobbering other accounts", () => {
    const next = dmPolicy.setPolicy(singleBotCfg, "allowlist", "staging");
    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    const accounts = section.accounts as Record<
      string,
      Record<string, unknown>
    >;
    // Default account dmPolicy unchanged
    expect(accounts.default.dmPolicy).toBe("open");
    expect(accounts.staging.dmPolicy).toBe("allowlist");
  });

  it("setPolicy writes the default account under accounts.default", () => {
    const next = dmPolicy.setPolicy(singleBotCfg, "allowlist", undefined);
    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    const accounts = section.accounts as Record<
      string,
      Record<string, unknown>
    >;
    expect(accounts.default.dmPolicy).toBe("allowlist");
  });
});
