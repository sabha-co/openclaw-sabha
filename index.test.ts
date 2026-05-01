// Loader-backed smoke test for the plugin's top-level entries.
//
// Catches the failure mode where `index.ts` or `setup-entry.ts` compiles
// cleanly but produces a runtime shape OpenClaw's loader rejects — e.g. a
// missing `register` function, an id/name drift after a rename, or
// `setup-entry.ts` accidentally exporting the channel plugin object instead
// of the SDK's `{ plugin }` wrapper.
//
// Equivalent to peers' `assertBundledChannelEntries` helper
// (extensions/discord/index.test.ts, extensions/slack/index.test.ts), but
// targets the external-plugin entry shape from `defineChannelPluginEntry`
// rather than the bundled-plugin `kind`-tagged shape.

import { describe, expect, it } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";
import { sabhaPlugin } from "./src/channel.js";

describe("sabha plugin entries", () => {
  it("channel entry exposes the contracted external-plugin shape", () => {
    expect(entry.id).toBe("sabha");
    expect(entry.name).toBe("Sabha");
    expect(typeof entry.description).toBe("string");
    expect(entry.description.length).toBeGreaterThan(0);
    expect(typeof entry.register).toBe("function");
    expect(entry.channelPlugin).toBe(sabhaPlugin);
    expect(entry.configSchema).toBeDefined();
  });

  it("setup entry wraps the same plugin object the channel entry exposes", () => {
    expect(setupEntry.plugin).toBe(sabhaPlugin);
    expect(setupEntry.plugin).toBe(entry.channelPlugin);
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
