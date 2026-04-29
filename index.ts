import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
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
    const getConfig = () => api.runtime.config.loadConfig();

    api.registerCli(
      async ({ program }) => {
        const { registerSabhaCli } = await import("./src/cli.js");
        registerSabhaCli({
          program,
          getConfig,
          writeConfigFile: (cfg) => api.runtime.config.writeConfigFile(cfg),
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
    // Migration shim: fold any leftover base-level credentials (botKey,
    // baseUrl, etc.) sitting at `channels.sabha.<field>` into
    // `channels.sabha.accounts.default` so the multi-account resolver
    // can see them. SDK-blessed (matrix/setup-helpers); idempotent — a
    // config that's already in the canonical shape is unchanged.
    //
    // The set of keys actually moved is the union of the SDK's static
    // common set and the arrays declared on `sabhaPlugin.setup` — see
    // `src/setup-contract.ts` for the Sabha-specific creds list. Without
    // that contract, the shim is a no-op for `botKey` / `baseUrl` /
    // `apiBaseUrl`, which would defeat the whole point.
    //
    // Closes the silent-leak footgun where base-level creds would be
    // inherited into every named account that doesn't override them.
    const before = api.runtime.config.loadConfig();
    const migratedCfg = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: before,
      channelKey: "sabha",
    });
    if (migratedCfg !== before) {
      api.logger.info?.(
        "[sabha] Migrated base-level credentials into channels.sabha.accounts.default",
      );
      // Fire-and-forget persistence. We don't await because `registerFull`
      // is invoked synchronously by the SDK loader (no await), so blocking
      // here can't actually delay gateway startup — and the in-process
      // checks below use `migratedCfg` directly instead of round-tripping
      // through `loadConfig()`, so they don't depend on the write
      // completing. If the write fails (read-only mount?) the operator
      // sees the error in logs; the resolver's base→default layering
      // means runtime behavior is correct from either shape.
      void api.runtime.config.writeConfigFile(migratedCfg).catch((err) => {
        api.logger.error?.(
          `[sabha] Failed to persist migrated config: ${err}`,
        );
      });
    }

    const getConfig = () => api.runtime.config.loadConfig();

    // Detect the silent-skip case: `channels.sabha` is set (operator thinks
    // sabha is configured) but no explicit `accounts` entries exist and the
    // base block has no credentials either. The SDK's listAccountIds returns
    // ["default"] as a fallback, so we can't use that for the warning;
    // listConfiguredSabhaAccountIds returns the truly-configured set.
    //
    // Uses `migratedCfg` (the in-memory post-migration shape) rather than
    // re-reading via `loadConfig()` so we don't race the on-disk write.
    if (
      migratedCfg.channels?.sabha &&
      listConfiguredSabhaAccountIds(migratedCfg).length === 0 &&
      !resolveSabhaAccount({ cfg: migratedCfg }).botKey
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
