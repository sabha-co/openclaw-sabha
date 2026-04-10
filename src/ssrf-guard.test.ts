import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { resolveAttachmentSsrfPolicy } from "./ssrf-guard.js";

function cfgWith(sabha: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

describe("resolveAttachmentSsrfPolicy", () => {
  it("returns undefined (strict default) when flag is absent", () => {
    expect(
      resolveAttachmentSsrfPolicy(cfgWith({ baseUrl: "https://sabha.co" })),
    ).toBeUndefined();
  });

  it("returns undefined when flag is explicitly false", () => {
    expect(
      resolveAttachmentSsrfPolicy(
        cfgWith({ allowPrivateAttachmentHosts: false }),
      ),
    ).toBeUndefined();
  });

  it("returns a permissive policy when flag is true", () => {
    const policy = resolveAttachmentSsrfPolicy(
      cfgWith({ allowPrivateAttachmentHosts: true }),
    );
    expect(policy).toBeDefined();
    // SDK produces a policy object that opts into private networks; the
    // exact shape is an SDK concern, we just need it to be non-nullish so
    // fetchRemoteMedia receives the opt-in.
    expect(typeof policy).toBe("object");
  });

  it("does not crash when channels.sabha is missing", () => {
    expect(
      resolveAttachmentSsrfPolicy({} as unknown as OpenClawConfig),
    ).toBeUndefined();
  });

  it("treats truthy non-boolean values as opt-out (strict only for exact true)", () => {
    // Accidentally setting the flag to a non-boolean shouldn't silently
    // disable the guard. Only `=== true` relaxes it.
    expect(
      resolveAttachmentSsrfPolicy(
        cfgWith({ allowPrivateAttachmentHosts: "yes" as unknown as boolean }),
      ),
    ).toBeUndefined();
    expect(
      resolveAttachmentSsrfPolicy(
        cfgWith({ allowPrivateAttachmentHosts: 1 as unknown as boolean }),
      ),
    ).toBeUndefined();
  });
});
