import { createChatChannelPlugin, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { type ResolvedSabhaAccount, listSabhaAccountIds, resolveSabhaAccountForSdk, resolveDefaultSabhaAccountId } from "./accounts.js";
import { inspectSabhaAccount } from "./account-inspect.js";
import { sabhaConfigSchema } from "./config-schema.js";
import { sabhaSetupContract } from "./setup-contract.js";
import { sabhaSetupWizard } from "./setup-wizard.js";

export const sabhaSetupPlugin = createChatChannelPlugin<ResolvedSabhaAccount>({
  base: {
    id: "sabha",
    setupWizard: sabhaSetupWizard,
    meta: {
      id: "sabha",
      label: "Sabha",
      selectionLabel: "Sabha (Bot API)",
      detailLabel: "Sabha Bot",
      docsPath: "/channels/sabha",
      docsLabel: "sabha",
      systemImage: "bubble.left.and.bubble.right",
      blurb: "Connect OpenClaw to a Sabha chat server.",
    },
    configSchema: sabhaConfigSchema,
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      edit: true,
      unsend: true,
      reply: true,
      threads: true,
      media: true,
      blockStreaming: true,
    },
    setupContract: sabhaSetupContract,
    config: {
      resolveAccount: resolveSabhaAccountForSdk,
      listAccountIds: listSabhaAccountIds,
      defaultAccountId: resolveDefaultSabhaAccountId,
      inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => inspectSabhaAccount({ cfg, accountId }),
    },
  },
  security: {
    dm: {
      channelKey: "sabha",
      resolvePolicy: (account: ResolvedSabhaAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedSabhaAccount) => account.allowFrom,
      defaultPolicy: "open",
    },
  },
});
