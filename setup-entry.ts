import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

// Bundled setup entry — the wizard half. Setup-only registration modes
// (`openclaw configure`) load this without pulling in the full gateway
// runtime. The plugin object lives in `./src/channel.js` and is the same
// `sabhaPlugin` reference the main entry uses; the bundled-setup contract
// just records the specifier and defers loading to `loadSetupPlugin()`.
export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "sabhaPlugin",
  },
});
