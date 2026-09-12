import { describe, expect, it } from "vitest";
import { sabhaSetupContract } from "./setup-contract.js";
import { SabhaConfigSchema } from "./config-schema.js";
import { resolveSabhaAccount } from "./accounts.js";

describe("canonical setup contract", () => {
  it("writes named credentials with shared settings and account overrides", () => {
    const cfg = { channels: { sabha: { baseUrl: "https://sabha.co/1000006", dmPolicy: "open" } } };
    const next = sabhaSetupContract.applyAccountConfig({ cfg, accountId: "primary", input: {
      botKey: "42-testkey", apiBaseUrl: "https://sabha.co/1000006/api/bots", dmPolicy: "allowlist", allowFrom: ["123"],
    } });
    expect(SabhaConfigSchema.safeParse(next.channels?.sabha).success).toBe(true);
    expect(resolveSabhaAccount({ cfg: next, accountId: "primary" })).toMatchObject({ botKey: "42-testkey", dmPolicy: "allowlist", allowFrom: ["123"], enabled: true });
    expect(cfg.channels.sabha).not.toHaveProperty("accounts");
  });
  it("rejects root credentials, with no runtime fallback or setup promotion", () => {
    const section = { botKey: "42-rootkey", accounts: { other: {} } };
    expect(SabhaConfigSchema.safeParse(section).success).toBe(false);
    expect(resolveSabhaAccount({ cfg: { channels: { sabha: section } }, accountId: "other" }).botKey).toBe("");
    expect(sabhaSetupContract.singleAccountKeysToMove).toBeUndefined();
    expect(sabhaSetupContract.namedAccountPromotionKeys).toBeUndefined();
    expect(sabhaSetupContract.configPromotion).toBe("preserve-root");
  });
  it("accepts room overrides at both shared and named account scopes", () => {
    expect(SabhaConfigSchema.safeParse({ rooms: { "1": { systemPrompt: "Shared" } }, accounts: { primary: { rooms: { "2": { systemPrompt: "Private" } } } } }).success).toBe(true);
  });
  it("rejects invalid setup fields before writing config", () => {
    expect(sabhaSetupContract.parseInput({ dmPolicy: "anyone" }).ok).toBe(false);
    expect(sabhaSetupContract.metadata.fields.find((field) => field.key === "botKey")).toMatchObject({ sensitive: true });
  });
});
