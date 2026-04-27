import { describe, it, expect } from "vitest";
import type { ResolvedSabhaAccount } from "./accounts.js";

import { resolveAttachmentSsrfPolicy } from "./ssrf-guard.js";

function account(
  overrides: Partial<ResolvedSabhaAccount> = {},
): ResolvedSabhaAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://sabha.example.com",
    apiBaseUrl: "https://sabha.example.com/api/bots",
    botKey: "1-test",
    webhookSecret: "whsec_test",
    botId: 1,
    botName: "Test",
    webhookPort: 8787,
    connectionMode: "websocket",
    websocketUrl: "",
    typingEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowPrivateAttachmentHosts: false,
    replyToMode: "first",
    rooms: {},
    ...overrides,
  };
}

describe("resolveAttachmentSsrfPolicy", () => {
  it("returns undefined (strict default) when flag is false", () => {
    expect(
      resolveAttachmentSsrfPolicy(account({ allowPrivateAttachmentHosts: false })),
    ).toBeUndefined();
  });

  it("returns a permissive policy when flag is true", () => {
    const policy = resolveAttachmentSsrfPolicy(
      account({ allowPrivateAttachmentHosts: true }),
    );
    expect(policy).toBeDefined();
    // SDK produces a policy object that opts into private networks; the
    // exact shape is an SDK concern, we just need it to be non-nullish so
    // fetchRemoteMedia receives the opt-in.
    expect(typeof policy).toBe("object");
  });

  it("resolves per bot account — one permissive, one strict", () => {
    const staging = account({
      accountId: "staging",
      allowPrivateAttachmentHosts: true,
    });
    const prod = account({
      accountId: "prod",
      allowPrivateAttachmentHosts: false,
    });
    expect(resolveAttachmentSsrfPolicy(staging)).toBeDefined();
    expect(resolveAttachmentSsrfPolicy(prod)).toBeUndefined();
  });

  it("treats truthy non-boolean values as opt-out (strict only for exact true)", () => {
    // Accidentally setting the flag to a non-boolean shouldn't silently
    // disable the guard. Only `=== true` relaxes it.
    expect(
      resolveAttachmentSsrfPolicy(
        account({
          allowPrivateAttachmentHosts: "yes" as unknown as boolean,
        }),
      ),
    ).toBeUndefined();
    expect(
      resolveAttachmentSsrfPolicy(
        account({ allowPrivateAttachmentHosts: 1 as unknown as boolean }),
      ),
    ).toBeUndefined();
  });
});
