import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

// Bundled-entry shim. This file is intentionally tiny: only static imports
// are from the SDK's entry contract and types. The plugin object and its
// transitive `openclaw/plugin-sdk/*` graph (~17 unique subpaths) load
// lazily via the string specifier below — only when the gateway calls
// `register(api)`, well after cold-start ESM-CJS bridging is done.
//
// Mirrors the WhatsApp / Telegram-canonical bundled shape. The motivation
// for the switch (cold-start `ERR_INTERNAL_ASSERTION` in
// `loadCJSModuleWithModuleLoad` against `defineChannelPluginEntry` on
// openclaw 2026.5.12 + Node 24.14.x) is recorded in the spike PR
// description; if the spike sticks, fold the rationale into CLAUDE.md.

const entry = defineBundledChannelEntry({
  id: "sabha",
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "sabhaPlugin",
  },

  // CLI-only registration path: runs on `openclaw sabha …` without loading
  // the full plugin (gateway, services, etc.). The cli surface itself is
  // imported lazily inside the register callback.
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

  registerFull(api: OpenClawPluginApi) {
    const getConfig = () => api.runtime.config.current() as OpenClawConfig;

    // Defer the heavier imports until after the entry file finishes
    // loading. `api.registerTool` and `api.logger.warn` are synchronous
    // SDK calls; the dynamic-import IIFE means they may fire slightly
    // later than the synchronous `register(api)` window. If that loses a
    // race with tool discovery we'll move these back to static imports —
    // see the spike notes. WhatsApp gets away without `registerFull`
    // because its tools live on the plugin object.
    void (async () => {
      const [{ listConfiguredSabhaAccountIds, resolveSabhaAccount }, { createSabhaTools }] =
        await Promise.all([
          import("./src/accounts.js"),
          import("./src/tools.js"),
        ]);

      const cfg = getConfig();

      // Detect the silent-skip case: `channels.sabha` is set (operator
      // thinks sabha is configured) but no explicit `accounts` entries
      // exist and the base block has no credentials either. The SDK's
      // listAccountIds returns ["default"] as a fallback, so we can't
      // use that for the warning; listConfiguredSabhaAccountIds returns
      // the truly-configured set.
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
    })().catch((err) => {
      api.logger.error(`[sabha] registerFull failed: ${String(err)}`);
    });
  },
});

export default entry;
