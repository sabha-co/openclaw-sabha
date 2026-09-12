import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { SABHA_TOOL_NAMES, SABHA_CLI_DESCRIPTORS } from "./src/metadata.js";
import { sabhaPlugin } from "./src/channel.js";
import { createSabhaTools } from "./src/tools.js";

const entry: ReturnType<typeof defineChannelPluginEntry<typeof sabhaPlugin>> = defineChannelPluginEntry({
  id: "sabha",
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  plugin: sabhaPlugin,
  registerCliMetadata(api: OpenClawPluginApi) {
    const getConfig = () => api.runtime.config.current() as OpenClawConfig;

    api.registerCli(
      async ({ program }) => {
        const { registerSabhaCli } = await import("./src/cli.js");
        registerSabhaCli({
          program,
          getConfig,
          writeConfigFile: async (cfg) => {
            await api.runtime.config.replaceConfigFile({
              nextConfig: cfg,
              afterWrite: { mode: "auto" },
            });
          },
        });
      },
      {
        descriptors: SABHA_CLI_DESCRIPTORS,
      },
    );
  },

  registerFull(api) {
    const factories = createSabhaTools(() => api.runtime.config.current() as OpenClawConfig);
    factories.forEach((factory, index) => api.registerTool(factory, { name: SABHA_TOOL_NAMES[index] }));
  },
});

export default entry;
