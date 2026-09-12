import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { resolveDefaultSabhaAccountId } from "./accounts.js";
import { setSabhaAccountConfig } from "./setup-wizard.js";

export const sabhaSetupContract: ReturnType<typeof defineChannelSetupContract> = defineChannelSetupContract({
  fields: {
    baseUrl: { kind: "string", cli: { flags: "--base-url <url>", description: "Sabha server URL including workspace prefix" } },
    apiBaseUrl: { kind: "string", cli: { flags: "--api-base-url <url>", description: "Sabha bot API URL" } },
    botKey: { kind: "string", sensitive: true, cli: { flags: "--bot-key <key>", description: "Sabha bot key" } },
    botName: { kind: "string", cli: { flags: "--bot-name <name>", description: "Bot display name" } },
    websocketUrl: { kind: "string", cli: { flags: "--websocket-url <url>", description: "Sabha cable URL" } },
    dmPolicy: { kind: "choice", choices: ["open", "allowlist"] as const, cli: { flags: "--dm-policy <policy>", description: "DM admission policy" } },
    allowFrom: { kind: "string-list", cli: { flags: "--allow-from <ids>", description: "Allowed Sabha user IDs" } },
  },
  adapter: {
    configPromotion: "preserve-root",
    resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultSabhaAccountId(cfg),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const { name: _name, ...fields } = input;
      return setSabhaAccountConfig(cfg, accountId, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    },
  },
});
