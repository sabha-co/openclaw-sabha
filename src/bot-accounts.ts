import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-core";

import type { SabhaConfig } from "./types.js";
import { extractBotId } from "./client.js";

// Sabha calls plugin-level identities "bot accounts" to avoid colliding with
// Sabha's own server-side account concept (multi-tenant workspaces, user
// accounts). A bot account is one `baseUrl + botKey + botName` tuple the
// plugin monitors and replies as.
//
// Config shape:
//   channels:
//     sabha:
//       # legacy / default bot account (kept as base for zero-migration):
//       baseUrl: ...
//       botKey: ...
//       # additional bots, layered over the base:
//       botAccounts:
//         staging:   { baseUrl: ..., botKey: ... }
//         prod-eu:   { baseUrl: ..., botKey: ... }
//       defaultBotAccount: prod-eu   # optional override
//
// Legacy single-bot configs work unchanged: `botAccounts` is absent, and the
// default account resolves to `"default"` with the base config as its
// merged config.

export type ResolvedBotAccount = {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  botKey: string;
  botId: number;
  botName: string;
  webhookPort: number;
  connectionMode: "websocket" | "webhook";
  websocketUrl: string;
  typingEnabled: boolean;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  allowPrivateAttachmentHosts: boolean;
};

// Fields we must NOT propagate from the base section into a per-bot merged
// config. These are top-level container fields, not bot-specific data.
const OMIT_KEYS = ["botAccounts", "defaultBotAccount"] as const;

function getSabhaSection(cfg: OpenClawConfig): SabhaConfig | undefined {
  return (cfg.channels as Record<string, unknown>)?.sabha as
    | SabhaConfig
    | undefined;
}

function getBotAccountsMap(
  cfg: OpenClawConfig,
): Record<string, Partial<SabhaConfig>> | undefined {
  const section = getSabhaSection(cfg);
  const map = section?.botAccounts;
  return map && typeof map === "object" ? map : undefined;
}

/**
 * Enumerate every bot account id the plugin should spin up. Always returns
 * at least one id so a legacy single-bot config still starts a monitor —
 * the base `channels.sabha` block acts as the "default" bot account when
 * no `botAccounts` map is present.
 */
export function listBotAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = getBotAccountsMap(cfg);
  const configuredIds = accounts
    ? Object.keys(accounts).filter(Boolean)
    : [];
  return listCombinedAccountIds({
    configuredAccountIds: configuredIds,
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
}

/**
 * Resolve the bot account id used when no explicit id is passed. Honors
 * `channels.sabha.defaultBotAccount` if present; otherwise falls back to the
 * SDK's alphabetic-first rule via `resolveListedDefaultAccountId`.
 */
export function resolveDefaultBotAccountId(cfg: OpenClawConfig): string {
  const section = getSabhaSection(cfg);
  const preferred = normalizeOptionalAccountId(
    typeof section?.defaultBotAccount === "string"
      ? section.defaultBotAccount
      : undefined,
  );
  return resolveListedDefaultAccountId({
    accountIds: listBotAccountIds(cfg),
    ...(preferred != null ? { configuredDefaultAccountId: preferred } : {}),
  });
}

/**
 * Build the merged per-bot config by layering the `botAccounts.<id>` entry
 * over the base `channels.sabha` block. Returns `undefined` for the fields
 * the user hasn't set yet — callers apply defaults via `resolveBotAccount`.
 */
export function mergeBotAccountConfig(
  cfg: OpenClawConfig,
  botAccountId: string,
): SabhaConfig {
  return resolveMergedAccountConfig<SabhaConfig & Record<string, unknown>>({
    channelConfig: getSabhaSection(cfg) as
      | (SabhaConfig & Record<string, unknown>)
      | undefined,
    accounts: getBotAccountsMap(cfg) as
      | Record<string, Partial<SabhaConfig & Record<string, unknown>>>
      | undefined,
    accountId: botAccountId,
    omitKeys: [...OMIT_KEYS],
  });
}

type ResolveBotAccountParams = {
  cfg: OpenClawConfig;
  botAccountId?: string | null;
};

/**
 * Resolve a bot account by id, applying defaults to every field the plugin
 * relies on. `botAccountId` defaults to `resolveDefaultBotAccountId(cfg)`
 * when omitted or nullish.
 */
export function resolveBotAccount(
  params: ResolveBotAccountParams,
): ResolvedBotAccount {
  const id = normalizeAccountId(
    params.botAccountId ?? resolveDefaultBotAccountId(params.cfg),
  );
  const baseEnabled = getSabhaSection(params.cfg)?.enabled !== false;
  const merged = mergeBotAccountConfig(params.cfg, id);
  const accountEnabled = merged.enabled !== false;

  return {
    accountId: id,
    enabled: baseEnabled && accountEnabled,
    baseUrl: merged.baseUrl ?? "",
    botKey: merged.botKey ?? "",
    botId: extractBotId(merged.botKey ?? ""),
    botName: merged.botName?.trim() || "OpenClaw",
    webhookPort: merged.webhookPort ?? 8787,
    connectionMode: merged.connectionMode ?? "websocket",
    websocketUrl: merged.websocketUrl ?? "",
    typingEnabled: merged.typingEnabled !== false,
    dmPolicy: merged.dmPolicy ?? "open",
    allowFrom: merged.allowFrom ?? [],
    allowPrivateAttachmentHosts: merged.allowPrivateAttachmentHosts === true,
  };
}

/**
 * SDK-boundary shim: the `createChatChannelPlugin` config surface expects
 * `resolveAccount(cfg, accountId?)` — forward into our `{cfg, botAccountId}`
 * shape so the plugin-internal naming stays distinct from Sabha's own
 * "accounts" concept.
 */
export function resolveBotAccountForSdk(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedBotAccount {
  return resolveBotAccount({ cfg, botAccountId: accountId });
}

/**
 * Enumerate every enabled bot account. Used by the doctor, status probe,
 * and any agent tool that needs to fan out across bots when no explicit
 * account is specified.
 */
export function listEnabledBotAccounts(
  cfg: OpenClawConfig,
): ResolvedBotAccount[] {
  return listBotAccountIds(cfg)
    .map((botAccountId) => resolveBotAccount({ cfg, botAccountId }))
    .filter((account) => account.enabled);
}
