import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("plugin entries", () => {
  it("registers the sabha channel on the gateway v2 adapter", () => {
    expect(entry.id).toBe("sabha");
    expect(entry.channelPlugin.id).toBe("sabha");
    expect(entry.channelPlugin.gateway?.apiVersion).toBe(2);
    expect(entry.channelPlugin.outbound?.deliveryMode).toBe("direct");
  });

  it("keeps the setup entry free of the gateway", () => {
    const plugin = (setupEntry as unknown as { plugin: { id: string; gateway?: unknown } }).plugin;
    expect(plugin.id).toBe("sabha");
    expect(plugin.gateway).toBeUndefined();
  });

  it.each(["cli-metadata", "full"] as const)("registers the sabha CLI and tools in %s mode", (registrationMode) => {
    const api = {
      registrationMode,
      runtime: { config: { current: vi.fn(() => ({})) } },
      registerChannel: vi.fn(),
      registerCli: vi.fn(),
      registerTool: vi.fn(),
    };
    entry.register(api as never);
    expect(api.registerCli).toHaveBeenCalledWith(expect.any(Function), { descriptors: [expect.objectContaining({ name: "sabha" })] });
    if (registrationMode === "full") {
      expect(api.registerTool.mock.calls.map(([, options]) => options)).toEqual([{ name: "sabha_search_members" }, { name: "sabha_create_dm" }]);
    }
  });
});
