import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import entry from "./index.js";

describe("entry registration", () => {
  it("registers both named factories synchronously without runtime in tool discovery", () => {
    const registerTool = vi.fn();
    const api = {
      registrationMode: "tool-discovery",
      registerTool,
      get runtime() { throw new Error("runtime unavailable in discovery"); },
      logger: { error: vi.fn(), warn: vi.fn() },
    } as unknown as OpenClawPluginApi;
    entry.register(api);
    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(registerTool.mock.calls.map(([, options]) => options.name)).toEqual([
      "sabha_search_members", "sabha_create_dm",
    ]);
    for (const [factory] of registerTool.mock.calls) expect(factory({}).execute).toBeTypeOf("function");
  });

  it("registers only CLI metadata in CLI mode", () => {
    const registerCli = vi.fn();
    entry.register({ registrationMode: "cli-metadata", registerCli } as unknown as OpenClawPluginApi);
    expect(registerCli).toHaveBeenCalledOnce();
    expect(registerCli.mock.calls[0][1].descriptors[0].name).toBe("sabha");
  });
});
