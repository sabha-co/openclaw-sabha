import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { patchSabhaAccount, resolveDefaultSabhaAccountId } from "./accounts.js";

export const sabhaSetupContract: ReturnType<typeof defineChannelSetupContract> = defineChannelSetupContract({
  fields: {
    url: { kind: "string", cli: { flags: "--url <url>", description: "Sabha workspace URL" } },
    appKey: { kind: "string", sensitive: true, cli: { flags: "--app-key <key>", description: "Sabha app key (sabha_app_…)" } },
    cableUrl: { kind: "string", cli: { flags: "--cable-url <url>", description: "Override the Sabha WebSocket URL" } },
    dmPolicy: {
      kind: "choice",
      choices: ["open", "allowlist"] as const,
      cli: { flags: "--dm-policy <policy>", description: "DM admission policy" },
    },
    allowFrom: { kind: "string-list", cli: { flags: "--allow-from <ids>", description: "Allowed Sabha user ids" } },
  },
  adapter: {
    configPromotion: "preserve-root",
    resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultSabhaAccountId(cfg),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const { name: _name, ...fields } = input;
      const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      return patchSabhaAccount(cfg, accountId, patch);
    },
  },
});
