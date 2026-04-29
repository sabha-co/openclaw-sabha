import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  inspectAllSabhaAccounts,
  inspectSabhaAccount,
} from "./account-inspect.js";

function cfg(sabha: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("inspectSabhaAccount", () => {
  it("reports a fully-configured WS account as available + configured", () => {
    const result = inspectSabhaAccount({
      cfg: cfg({
        baseUrl: "https://sabha.co/1000006",
        apiBaseUrl: "https://sabha.co/1000006/api/bots",
        accounts: {
          default: { botKey: "42-AbCdEfGhIjKl" },
        },
      }),
    });

    expect(result.accountId).toBe("default");
    expect(result.enabled).toBe(true);
    expect(result.tokenStatus).toBe("available");
    expect(result.tokenSource).toBe("config");
    expect(result.baseUrlStatus).toBe("available");
    expect(result.apiBaseUrlStatus).toBe("available");
    expect(result.configured).toBe(true);
  });

  it("reports an empty botKey as missing + not configured", () => {
    const result = inspectSabhaAccount({
      cfg: cfg({
        baseUrl: "https://sabha.co/1000006",
        apiBaseUrl: "https://sabha.co/1000006/api/bots",
        accounts: {
          default: { botKey: "" },
        },
      }),
    });

    // Empty string = operator set the field but to an empty value, distinct
    // from "never set". Tri-state matters for the audit layer's "configured
    // but unavailable" warnings.
    expect(result.tokenStatus).toBe("configured_unavailable");
    expect(result.tokenSource).toBe("config");
    expect(result.configured).toBe(false);
  });

  it("reports a wholly-unconfigured account as missing on every field", () => {
    const result = inspectSabhaAccount({
      cfg: cfg({ accounts: { default: {} } }),
    });

    expect(result.tokenStatus).toBe("missing");
    expect(result.tokenSource).toBe("none");
    expect(result.baseUrlStatus).toBe("missing");
    expect(result.apiBaseUrlStatus).toBe("missing");
    expect(result.configured).toBe(false);
  });

  it("reflects channel-level disabled flag", () => {
    const result = inspectSabhaAccount({
      cfg: cfg({
        enabled: false,
        baseUrl: "https://sabha.co/1000006",
        apiBaseUrl: "https://sabha.co/1000006/api/bots",
        accounts: {
          default: { botKey: "42-AbCdEfGhIjKl" },
        },
      }),
    });

    expect(result.enabled).toBe(false);
    // Disabled doesn't make `configured` false — credentials are still set.
    expect(result.configured).toBe(true);
  });

  it("reflects per-account disabled flag", () => {
    const result = inspectSabhaAccount({
      cfg: cfg({
        baseUrl: "https://sabha.co/1000006",
        apiBaseUrl: "https://sabha.co/1000006/api/bots",
        accounts: {
          default: { botKey: "42-AbCdEfGhIjKl", enabled: false },
        },
      }),
    });

    expect(result.enabled).toBe(false);
  });

  it("uses botName when set, falls back to OpenClaw when not", () => {
    const named = inspectSabhaAccount({
      cfg: cfg({
        accounts: { default: { botKey: "42-x", botName: "ApprovalBot" } },
      }),
    });
    expect(named.name).toBe("ApprovalBot");

    const unnamed = inspectSabhaAccount({
      cfg: cfg({ accounts: { default: { botKey: "42-x" } } }),
    });
    expect(unnamed.name).toBe("OpenClaw");
  });

  it("resolves an explicit accountId in a multi-bot config", () => {
    const config = cfg({
      baseUrl: "https://sabha.co/1000006",
      apiBaseUrl: "https://sabha.co/1000006/api/bots",
      accounts: {
        production: { botKey: "1-prod" },
        staging: { botKey: "2-staging" },
      },
    });

    const prod = inspectSabhaAccount({ cfg: config, accountId: "production" });
    const staging = inspectSabhaAccount({ cfg: config, accountId: "staging" });

    expect(prod.accountId).toBe("production");
    expect(staging.accountId).toBe("staging");
    // Both reach into their own per-account override.
    expect(prod.config.botKey).toBe("1-prod");
    expect(staging.config.botKey).toBe("2-staging");
  });

  it("falls back to the default account id when accountId is null/empty", () => {
    const config = cfg({
      baseUrl: "https://sabha.co/1000006",
      apiBaseUrl: "https://sabha.co/1000006/api/bots",
      accounts: {
        production: { botKey: "1-prod" },
        staging: { botKey: "2-staging" },
      },
      defaultAccount: "staging",
    });

    expect(inspectSabhaAccount({ cfg: config }).accountId).toBe("staging");
    expect(inspectSabhaAccount({ cfg: config, accountId: null }).accountId).toBe("staging");
    expect(inspectSabhaAccount({ cfg: config, accountId: "" }).accountId).toBe("staging");
  });

  it("includes the full merged config so audit can reuse it", () => {
    const result = inspectSabhaAccount({
      cfg: cfg({
        baseUrl: "https://sabha.co/1000006",
        apiBaseUrl: "https://sabha.co/1000006/api/bots",
        accounts: {
          default: {
            botKey: "42-x",
            replyToMode: "all",
            dmPolicy: "allowlist",
            allowFrom: ["7", "9"],
          },
        },
      }),
    });

    expect(result.config.replyToMode).toBe("all");
    expect(result.config.dmPolicy).toBe("allowlist");
    expect(result.config.allowFrom).toEqual(["7", "9"]);
  });
});

describe("inspectAllSabhaAccounts", () => {
  it("returns one snapshot per configured account", () => {
    const results = inspectAllSabhaAccounts(
      cfg({
        baseUrl: "https://sabha.co/1000006",
        apiBaseUrl: "https://sabha.co/1000006/api/bots",
        accounts: {
          production: { botKey: "1-prod" },
          staging: { botKey: "2-staging" },
        },
      }),
    );

    expect(results.map((r) => r.accountId).sort()).toEqual(["production", "staging"]);
    expect(results.every((r) => r.tokenStatus === "available")).toBe(true);
  });
});
