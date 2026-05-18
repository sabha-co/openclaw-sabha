import {
  defineChannelPluginEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin } from "./src/channel.js";
import {
  listConfiguredSabhaAccountIds,
  resolveSabhaAccount,
} from "./src/accounts.js";
import { createSabhaTools } from "./src/tools.js";

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
  id: "sabha",
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  plugin: sabhaPlugin,

  // CLI-only registration path: runs on `openclaw sabha …` without loading the
  // full plugin (gateway, services, etc.)
  registerCliMetadata(api) {
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
        descriptors: [
          {
            name: "sabha",
            description: "Sabha channel commands",
            hasSubcommands: true,
          },
        ],
      },
    );
  },

  registerFull(api) {
    const getConfig = () => api.runtime.config.current() as OpenClawConfig;
    const cfg = getConfig();

    // Detect the silent-skip case: `channels.sabha` is set (operator thinks
    // sabha is configured) but no explicit `accounts` entries exist and the
    // base block has no credentials either. The SDK's listAccountIds returns
    // ["default"] as a fallback, so we can't use that for the warning;
    // listConfiguredSabhaAccountIds returns the truly-configured set.
    if (
      cfg.channels?.sabha &&
      listConfiguredSabhaAccountIds(cfg).length === 0 &&
      !resolveSabhaAccount({ cfg }).botKey
    ) {
      api.logger.warn(
        "[sabha] channels.sabha is set but has no accounts entries and no base-level botKey — " +
          "no Sabha bot will start. Add credentials under accounts.<id> " +
          "(e.g. accounts.default) or run `openclaw configure --section channels`. " +
          "See https://github.com/sabha-co/openclaw-sabha#configure for the correct shape.",
      );
    }

    // Register room/member management agent tools. Each entry is a
    // factory `(ctx) => tool` so the SDK can inject fresh agent context
    // (including `ctx.agentAccountId`) per invocation.
    const toolFactories = createSabhaTools(getConfig);
    for (const factory of toolFactories) {
      api.registerTool(factory);
    }
  },
});

export default entry;
