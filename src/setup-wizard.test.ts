import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  getBotAccountView,
  isDefaultBotAccount,
  sabhaSetupWizard,
  setBotAccountConfig,
} from "./setup-wizard.js";

type Cfg = OpenClawConfig;

const emptyCfg: Cfg = { channels: {} } as Cfg;

const legacyCfg: Cfg = {
  channels: {
    sabha: {
      baseUrl: "https://sabha.example.com",
      botKey: "42-legacy",
      botName: "Default Bot",
      dmPolicy: "open",
    },
  },
} as unknown as Cfg;

const multiCfg: Cfg = {
  channels: {
    sabha: {
      baseUrl: "https://sabha.example.com",
      botKey: "42-legacy",
      botName: "Default Bot",
      botAccounts: {
        staging: {
          baseUrl: "https://staging.sabha.example.com",
          botKey: "17-staging",
          botName: "Staging Bot",
        },
      },
    },
  },
} as unknown as Cfg;

describe("isDefaultBotAccount", () => {
  it("treats undefined and null as the default account", () => {
    expect(isDefaultBotAccount(undefined)).toBe(true);
    expect(isDefaultBotAccount(null)).toBe(true);
    expect(isDefaultBotAccount("")).toBe(true);
  });

  it("recognizes the canonical default id", () => {
    expect(isDefaultBotAccount("default")).toBe(true);
  });

  it("returns false for named accounts", () => {
    expect(isDefaultBotAccount("staging")).toBe(false);
    expect(isDefaultBotAccount("prod-eu")).toBe(false);
  });
});

describe("getBotAccountView", () => {
  it("reads the base section for the default account on a legacy config", () => {
    const view = getBotAccountView(legacyCfg, undefined);
    expect(view.baseUrl).toBe("https://sabha.example.com");
    expect(view.botKey).toBe("42-legacy");
  });

  it("returns an empty view when nothing is configured", () => {
    const view = getBotAccountView(emptyCfg, undefined);
    expect(view.baseUrl).toBeUndefined();
    expect(view.botKey).toBeUndefined();
  });

  it("layers a named account on top of the base", () => {
    const view = getBotAccountView(multiCfg, "staging");
    // Override wins for fields set in the named entry
    expect(view.baseUrl).toBe("https://staging.sabha.example.com");
    expect(view.botKey).toBe("17-staging");
    expect(view.botName).toBe("Staging Bot");
  });

  it("still returns the base values for the default account when named accounts exist", () => {
    const view = getBotAccountView(multiCfg, undefined);
    expect(view.baseUrl).toBe("https://sabha.example.com");
    expect(view.botKey).toBe("42-legacy");
  });
});

describe("setBotAccountConfig", () => {
  it("writes the default account into the base section (legacy-compatible)", () => {
    const next = setBotAccountConfig(emptyCfg, undefined, {
      baseUrl: "https://chat.example.com",
      botKey: "5-new",
      botName: "New",
    });
    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    expect(section.baseUrl).toBe("https://chat.example.com");
    expect(section.botKey).toBe("5-new");
    expect(section.enabled).toBe(true);
    // Must NOT create a botAccounts map when only the default is being saved
    expect(section.botAccounts).toBeUndefined();
  });

  it("writes a named account under botAccounts.<id> without clobbering the base", () => {
    const next = setBotAccountConfig(legacyCfg, "staging", {
      baseUrl: "https://staging.sabha.example.com",
      botKey: "17-staging",
      botName: "Staging Bot",
    });

    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;

    // Base is preserved unchanged
    expect(section.baseUrl).toBe("https://sabha.example.com");
    expect(section.botKey).toBe("42-legacy");

    // Named account is nested under botAccounts
    const botAccounts = section.botAccounts as Record<string, Record<string, unknown>>;
    expect(botAccounts.staging.baseUrl).toBe("https://staging.sabha.example.com");
    expect(botAccounts.staging.botKey).toBe("17-staging");
    expect(botAccounts.staging.enabled).toBe(true);
  });

  it("edits an existing named account in place", () => {
    const next = setBotAccountConfig(multiCfg, "staging", {
      botName: "Staging Bot v2",
    });
    const botAccounts = (
      (next.channels as Record<string, unknown>).sabha as Record<string, unknown>
    ).botAccounts as Record<string, Record<string, unknown>>;
    // Patched field updated; untouched fields preserved
    expect(botAccounts.staging.botName).toBe("Staging Bot v2");
    expect(botAccounts.staging.baseUrl).toBe(
      "https://staging.sabha.example.com",
    );
    expect(botAccounts.staging.botKey).toBe("17-staging");
  });

  it("normalizes whitespace / case on the named-account id", () => {
    const next = setBotAccountConfig(emptyCfg, "  Staging  ", {
      baseUrl: "x",
      botKey: "1-x",
    });
    const botAccounts = (
      (next.channels as Record<string, unknown>).sabha as Record<string, unknown>
    ).botAccounts as Record<string, unknown>;
    // normalizeAccountId lowercases + trims
    expect(Object.keys(botAccounts)).toEqual(["staging"]);
  });
});

describe("sabhaSetupWizard.status.resolveConfigured", () => {
  const resolveConfigured = sabhaSetupWizard.status.resolveConfigured;

  it("returns true for the default account on a legacy config", () => {
    expect(resolveConfigured({ cfg: legacyCfg, accountId: undefined })).toBe(
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
    expect(resolveConfigured({ cfg: multiCfg, accountId: "prod" })).toBe(true);
    // ^ "prod" inherits base credentials because no override exists. This
    //   matches Slack/Discord semantics: the base section is the implicit
    //   default for any account id not explicitly overridden. If you want
    //   a fresh account to start unconfigured, the wizard will overwrite
    //   the credentials via setBotAccountConfig.
  });
});

describe("sabhaSetupWizard.dmPolicy", () => {
  const dmPolicy = sabhaSetupWizard.dmPolicy!;

  it("getCurrent honors accountId", () => {
    const cfg: Cfg = {
      channels: {
        sabha: {
          baseUrl: "https://sabha.example.com",
          botKey: "42-x",
          dmPolicy: "open",
          botAccounts: {
            staging: { dmPolicy: "allowlist" },
          },
        },
      },
    } as unknown as Cfg;

    expect(dmPolicy.getCurrent(cfg, undefined)).toBe("open");
    expect(dmPolicy.getCurrent(cfg, "staging")).toBe("allowlist");
  });

  it("setPolicy writes to the named account without clobbering the base", () => {
    const next = dmPolicy.setPolicy(legacyCfg, "allowlist", "staging");
    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    // Base dmPolicy unchanged
    expect(section.dmPolicy).toBe("open");
    const botAccounts = section.botAccounts as Record<
      string,
      Record<string, unknown>
    >;
    expect(botAccounts.staging.dmPolicy).toBe("allowlist");
  });

  it("setPolicy still writes the base section for the default account", () => {
    const next = dmPolicy.setPolicy(legacyCfg, "allowlist", undefined);
    const section = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    expect(section.dmPolicy).toBe("allowlist");
    expect(section.botAccounts).toBeUndefined();
  });
});
