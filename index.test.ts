// Loader-backed smoke test for the plugin's top-level entries.
//
// Catches the failure mode where `index.ts` or `setup-entry.ts` compiles
// cleanly but produces a runtime shape OpenClaw's loader rejects — e.g. a
// missing `kind` discriminator after a contract migration, an id/name drift,
// or `setup-entry.ts` accidentally exporting the channel plugin object
// instead of the SDK's bundled-setup-entry contract.
//
// Uses the SDK's canonical `assertBundledChannelEntries` helper for the
// entry-contract surface (matches WhatsApp / Telegram bundled tests). The
// third describe-it walks the plugin object directly to catch capability
// regressions that the contract assertions can't see.

import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";
import { sabhaPlugin } from "./src/channel.js";

describe("sabha bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "sabha",
    expectedName: "Sabha",
    setupEntry,
  });

  it("plugin object declares the chat-channel surface the loader reads", () => {
    expect(sabhaPlugin.id).toBe("sabha");
    expect(sabhaPlugin.capabilities).toBeDefined();
    expect(sabhaPlugin.gateway).toBeDefined();
    expect(typeof sabhaPlugin.gateway?.startAccount).toBe("function");
    expect(sabhaPlugin.outbound).toBeDefined();
    expect(sabhaPlugin.directory).toBeDefined();
    expect(sabhaPlugin.actions).toBeDefined();
    expect(sabhaPlugin.messaging).toBeDefined();
    expect(sabhaPlugin.setup).toBeDefined();
  });
});
