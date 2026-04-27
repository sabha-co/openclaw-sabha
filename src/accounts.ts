import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-core";

import type { SabhaConfig, SabhaRoomConfig } from "./types.js";
import { extractBotId } from "./client.js";

// Multi-account config shape (canonical SDK keys — matches Feishu / Slack /
// Discord). The plugin reads `channels.sabha.accounts.<id>` layered over the
// shared base block; `defaultAccount` selects the bot account used when no
// explicit id is passed.
//
//   channels:
//     sabha:
//       # shared base fields (inherited by every account unless overridden):
//       baseUrl: ...
//       apiBaseUrl: ...
//       # per-account entries:
//       accounts:
//         default:   { botKey: ..., webhookSecret: ... }
//         staging:   { baseUrl: ..., apiBaseUrl: ..., botKey: ..., webhookSecret: ... }
//         prod-eu:   { baseUrl: ..., apiBaseUrl: ..., botKey: ..., webhookSecret: ... }
//       defaultAccount: prod-eu   # optional override

export type ResolvedSabhaAccount = {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  apiBaseUrl: string;
  botKey: string;
  // `undefined` means "not captured yet" — distinct from an empty string
  // so future HMAC verification can fail-closed on unregistered bots
  // without false-accepting a legitimately-empty secret.
  webhookSecret?: string;
  botId: number;
  botName: string;
  webhookPort: number;
  connectionMode: "websocket" | "webhook";
  websocketUrl: string;
  typingEnabled: boolean;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  allowPrivateAttachmentHosts: boolean;
  // Plugin-resolved replyToMode. The SDK's reply planner reads this through
  // the threading adapter (see `channel.ts:threading.resolveReplyToMode`)
  // so the SDK and the plugin's deliver callbacks see the same per-account
  // value.
  replyToMode: "off" | "first" | "all";
  // Shallow-replaced by per-account override if present, not deep-merged.
  rooms: Record<string, SabhaRoomConfig>;
};

const helpers = createAccountListHelpers("sabha");

/**
 * Every account id the plugin should spin up. Includes the SDK's implicit
 * `default` fallback when no `accounts` entries exist (matches peer
 * plugins) — `gateway.startAccount` will run for it but skip the
 * WebSocket monitor unless credentials are present.
 */
export const listSabhaAccountIds = helpers.listAccountIds;

/**
 * Account ids the operator has *explicitly* configured under
 * `channels.sabha.accounts.<id>`. Distinct from `listSabhaAccountIds` in
 * that the SDK fallback `default` is NOT included. Use this for startup
 * warnings and any "did the operator actually configure anything?" check.
 */
export const listConfiguredSabhaAccountIds = helpers.listConfiguredAccountIds;

function getSabhaSection(cfg: OpenClawConfig): SabhaConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.sabha as
    | SabhaConfig
    | undefined;
}

/**
 * Resolve the account id used when no explicit id is passed. Honors
 * `channels.sabha.defaultAccount` if present; otherwise falls back to the
 * SDK's alphabetic-first rule.
 */
export function resolveDefaultSabhaAccountId(cfg: OpenClawConfig): string {
  return helpers.resolveDefaultAccountId(cfg);
}

/**
 * Build the merged per-account config by layering `accounts.<id>` over the
 * base `channels.sabha` block. Returns `undefined` for fields the operator
 * hasn't set yet — callers apply defaults via `resolveSabhaAccount`.
 */
export function mergeSabhaAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SabhaConfig {
  const section = getSabhaSection(cfg);
  return resolveMergedAccountConfig<SabhaConfig & Record<string, unknown>>({
    channelConfig: section as
      | (SabhaConfig & Record<string, unknown>)
      | undefined,
    accounts: section?.accounts as
      | Record<string, Partial<SabhaConfig & Record<string, unknown>>>
      | undefined,
    accountId,
    // SDK's mergeAccountConfig auto-omits `accounts`; we only need to
    // strip the channel-level `defaultAccount` selector.
    omitKeys: ["defaultAccount"],
  });
}

type ResolveSabhaAccountParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
};

/**
 * Resolve a Sabha account by id, applying defaults to every field the plugin
 * relies on. `accountId` defaults to `resolveDefaultSabhaAccountId(cfg)`
 * when omitted or nullish.
 */
export function resolveSabhaAccount(
  params: ResolveSabhaAccountParams,
): ResolvedSabhaAccount {
  const id = normalizeAccountId(
    params.accountId ?? resolveDefaultSabhaAccountId(params.cfg),
  );
  const baseEnabled = getSabhaSection(params.cfg)?.enabled !== false;
  const merged = mergeSabhaAccountConfig(params.cfg, id);
  const accountEnabled = merged.enabled !== false;

  return {
    accountId: id,
    enabled: baseEnabled && accountEnabled,
    baseUrl: merged.baseUrl ?? "",
    apiBaseUrl: merged.apiBaseUrl ?? "",
    botKey: merged.botKey ?? "",
    // No `?? ""` default — empty would be indistinguishable from a
    // captured empty secret. See the field's doc comment.
    ...(merged.webhookSecret !== undefined
      ? { webhookSecret: merged.webhookSecret }
      : {}),
    botId: extractBotId(merged.botKey ?? ""),
    botName: merged.botName?.trim() || "OpenClaw",
    webhookPort: merged.webhookPort ?? 8787,
    connectionMode: merged.connectionMode ?? "websocket",
    websocketUrl: merged.websocketUrl ?? "",
    typingEnabled: merged.typingEnabled !== false,
    dmPolicy: merged.dmPolicy ?? "open",
    allowFrom: merged.allowFrom ?? [],
    allowPrivateAttachmentHosts: merged.allowPrivateAttachmentHosts === true,
    replyToMode: merged.replyToMode ?? "first",
    rooms: merged.rooms ?? {},
  };
}

/**
 * SDK-boundary shim: the `createChatChannelPlugin` config surface expects
 * `resolveAccount(cfg, accountId?)` — forward into our `{cfg, accountId}`
 * shape.
 */
export function resolveSabhaAccountForSdk(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSabhaAccount {
  return resolveSabhaAccount({ cfg, accountId });
}

/**
 * Enumerate every enabled Sabha account. Used by the doctor, status probe,
 * and any agent tool that needs to fan out across accounts when no explicit
 * one is specified.
 */
export function listEnabledSabhaAccounts(
  cfg: OpenClawConfig,
): ResolvedSabhaAccount[] {
  return listSabhaAccountIds(cfg)
    .map((accountId) => resolveSabhaAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
