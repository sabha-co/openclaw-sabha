import { defineChannelPluginEntry, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin } from "./src/plugin/channel.js";
import { SABHA_CHANNEL_ID, SABHA_CLI_DESCRIPTORS, SABHA_TOOL_NAMES } from "./src/plugin/meta.js";
import { setSabhaRuntime } from "./src/runtime.js";
import { createSabhaTools } from "./src/tools.js";

const entry: ReturnType<typeof defineChannelPluginEntry<typeof sabhaPlugin>> = defineChannelPluginEntry({
  id: SABHA_CHANNEL_ID,
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha workspace as an app",
  plugin: sabhaPlugin,
  setRuntime: setSabhaRuntime,
  registerCliMetadata: (api) => {
    api.registerCli(
      async ({ program }) => {
        const { registerSabhaCli } = await import("./src/cli.js");
        registerSabhaCli({
          program,
          getConfig: () => api.runtime.config.current({ clone: true }),
          writeConfig: async (nextConfig: OpenClawConfig) => {
            await api.runtime.config.replaceConfigFile({ nextConfig, afterWrite: { mode: "auto" } });
          },
        });
      },
      { descriptors: SABHA_CLI_DESCRIPTORS },
    );
  },
  registerFull: (api) => {
    const tools = createSabhaTools(() => api.runtime.config.current({ clone: true }));
    tools.forEach((tool, index) => api.registerTool(tool, { name: SABHA_TOOL_NAMES[index]! }));
  },
});

export default entry;
