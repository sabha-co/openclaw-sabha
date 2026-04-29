import { describe, expect, it } from "vitest";
import {
  sabhaNamedAccountPromotionKeys,
  sabhaSetupAdapter,
  sabhaSingleAccountKeysToMove,
} from "./setup-contract.js";
import { resolveSabhaAccount } from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

// These tests pin the migration contract that
// `moveSingleAccountChannelSectionToDefaultAccount` reads in
// `index.ts:registerFull`. The SDK's static
// `COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE` set covers `dmPolicy`, `allowFrom`
// (etc.) but NOT Sabha's actual credentials — so without these arrays the
// migration shim is a no-op for the very fields it's supposed to promote.
// Regressing either list silently breaks the rename's promise: every named
// account keeps inheriting base-level creds.

describe("sabhaSingleAccountKeysToMove", () => {
  it("includes the core credential fields the SDK common set misses", () => {
    // baseUrl / apiBaseUrl / botKey are not in
    // COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE; if we drop them here, a
    // legacy single-account install upgrades into a config where the
    // resolver sees an empty `accounts.default` and falls back to
    // base-layer inheritance forever.
    expect(sabhaSingleAccountKeysToMove).toEqual(
      expect.arrayContaining([
        "baseUrl",
        "apiBaseUrl",
        "botKey",
        "botName",
        "websocketUrl",
      ]),
    );
  });

  it("includes per-account behavioral fields without schema defaults", () => {
    // `rooms` and `allowPrivateAttachmentHosts` have no `default:` in
    // the JSON schema, so they only appear at the base block when an
    // operator actually wrote them there pre-rename — those are
    // genuine migration candidates.
    expect(sabhaSingleAccountKeysToMove).toEqual(
      expect.arrayContaining(["rooms", "allowPrivateAttachmentHosts"]),
    );
  });

  it("excludes schema-defaulted behavioral keys to avoid a config-rewrite loop", () => {
    // `typingEnabled` and `replyToMode` have `default:` values in
    // openclaw.plugin.json. The schema loader injects them before the
    // migration shim runs, so listing them makes the shim "promote"
    // defaults that were never on disk, causing an infinite boot loop.
    expect(sabhaSingleAccountKeysToMove).not.toContain("typingEnabled");
    expect(sabhaSingleAccountKeysToMove).not.toContain("replyToMode");
  });

  it("does not list channel-level keys that the SDK already filters", () => {
    // The SDK auto-strips `accounts`, `defaultAccount`, and `enabled`
    // from the migration set. Listing them here would be harmless but
    // signals confusion about what the contract is for.
    expect(sabhaSingleAccountKeysToMove).not.toContain("accounts");
    expect(sabhaSingleAccountKeysToMove).not.toContain("defaultAccount");
    expect(sabhaSingleAccountKeysToMove).not.toContain("enabled");
  });
});

describe("sabhaNamedAccountPromotionKeys", () => {
  it("includes per-account credentials and identity", () => {
    // When named accounts already exist (e.g. operator added
    // `accounts.staging` but legacy creds still sit at the channel
    // root), the migration shim only promotes fields in this list.
    // botKey MUST be here or the silent-leak footgun reopens —
    // staging would silently inherit the base-level botKey instead
    // of the migration moving it into accounts.default.
    expect(sabhaNamedAccountPromotionKeys).toEqual(
      expect.arrayContaining([
        "botKey",
        "botName",
        "websocketUrl",
      ]),
    );
  });

  it("does not promote shared workspace fields when named accounts exist", () => {
    // baseUrl / apiBaseUrl are commonly shared across bots in one
    // Sabha tenant. Promoting them into accounts.default when named
    // accounts exist would surprise an operator who intentionally set
    // a workspace-wide baseUrl at the channel root.
    expect(sabhaNamedAccountPromotionKeys).not.toContain("baseUrl");
    expect(sabhaNamedAccountPromotionKeys).not.toContain("apiBaseUrl");
    expect(sabhaNamedAccountPromotionKeys).not.toContain("dmPolicy");
    expect(sabhaNamedAccountPromotionKeys).not.toContain("replyToMode");
  });
});

describe("sabhaSetupAdapter.applyAccountConfig", () => {
  // Smoke test the adapter satisfies the SDK contract. Heavier coverage
  // of `setSabhaAccountConfig` lives in setup-wizard.test.ts.

  it("writes into accounts.<id>, not the base block", () => {
    const cfg = { channels: {} } as unknown as OpenClawConfig;
    const next = sabhaSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {},
    });

    const sabha = (next.channels as Record<string, unknown>).sabha as Record<
      string,
      unknown
    >;
    expect(sabha.accounts).toBeDefined();
    expect(sabha.botKey).toBeUndefined();
  });

  it("enables the resolved account so a downstream resolveSabhaAccount sees enabled: true", () => {
    const cfg = { channels: {} } as unknown as OpenClawConfig;
    const next = sabhaSetupAdapter.applyAccountConfig({
      cfg,
      accountId: "staging",
      input: {},
    });

    expect(resolveSabhaAccount({ cfg: next, accountId: "staging" }).enabled).toBe(true);
  });
});
