// The setup-only plugin: metadata, schema, config, setup and status. Loaded by
// setup-entry.ts and spread as the base of the full plugin. It must not import
// the client, monitor, socket, outbound or tools graphs.
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  inspectSabhaAccount,
  listSabhaAccountIds,
  resolveDefaultSabhaAccountId,
  resolveSabhaAccount,
  type ResolvedSabhaAccount,
} from "../config/accounts.js";
import { sabhaConfigSchema } from "../config/schema.js";
import { sabhaSetupContract } from "../config/setup-contract.js";
import { sabhaSetupWizard } from "../config/setup-wizard.js";
import { SABHA_CHANNEL_ID, sabhaMeta } from "./meta.js";

export const sabhaSetupPlugin: ChannelPlugin<ResolvedSabhaAccount> = {
  id: SABHA_CHANNEL_ID,
  meta: { ...sabhaMeta },
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
  reload: {
    configPrefixes: ["channels.sabha"],
    // Resolution reads the channel root plus the selected account, never a sibling.
    accountScopedRestart: true,
  },
  configSchema: sabhaConfigSchema,
  config: {
    listAccountIds: listSabhaAccountIds,
    defaultAccountId: resolveDefaultSabhaAccountId,
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => resolveSabhaAccount(cfg, accountId),
    inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => inspectSabhaAccount(cfg, accountId),
    isConfigured: (account: ResolvedSabhaAccount) => account.configured,
    describeAccount: (account: ResolvedSabhaAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.url,
    }),
  },
  setupContract: sabhaSetupContract,
  setupWizard: sabhaSetupWizard,
};
