import { normalizeAccountId, resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { SabhaAccountConfig, SabhaChannelConfig, SabhaRoomConfig } from "./schema.js";

// channels.sabha.accounts.<id> holds every credential; the channel root may
// hold shared, non-credential defaults. Only explicitly listed accounts run.
//
//   channels:
//     sabha:
//       url: https://sabha.co/1000006        # shared default
//       accounts:
//         default: { appKey: sabha_app_… }
//         staging: { url: https://chat.example.test, appKey: sabha_app_… }

export type SabhaDmPolicy = "open" | "allowlist";
export type SabhaReplyToMode = "off" | "first" | "all";
export type SabhaCredentialStatus = "available" | "configured_unavailable" | "missing";

export type ResolvedSabhaAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  /** Workspace URL without a trailing slash, e.g. https://sabha.co/1000006. */
  url: string;
  appKey: string;
  /** `${url}/api/v1`. */
  apiBaseUrl: string;
  /** ActionCable endpoint, derived from `url` unless overridden. */
  cableUrl: string;
  dmPolicy: SabhaDmPolicy;
  allowFrom: string[];
  allowPrivateNetwork: boolean;
  replyToMode: SabhaReplyToMode;
  livePreview: boolean;
  rooms: Record<string, SabhaRoomConfig>;
  config: SabhaAccountConfig;
};

const CREDENTIAL_KEYS = ["appKey", "cableUrl", "name"] as const;

const helpers = createAccountListHelpers("sabha", { normalizeAccountId });

export function sabhaSection(cfg: OpenClawConfig): SabhaChannelConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.sabha as SabhaChannelConfig | undefined;
}

export const listSabhaAccountIds = (cfg: OpenClawConfig): string[] => helpers.listConfiguredAccountIds(cfg).sort();

export function resolveDefaultSabhaAccountId(cfg: OpenClawConfig): string {
  return helpers.resolveDefaultAccountId(cfg);
}

/** The named account layered over the root's shared fields; `{}` when the account is not listed. */
export function mergeSabhaAccountConfig(cfg: OpenClawConfig, accountId: string): SabhaAccountConfig {
  const section = sabhaSection(cfg);
  const account = resolveNormalizedAccountEntry(section?.accounts, accountId, normalizeAccountId);
  if (!account) return {};
  const { accounts: _accounts, defaultAccount: _default, ...shared } = section ?? {};
  for (const key of CREDENTIAL_KEYS) delete (shared as Record<string, unknown>)[key];
  return { ...shared, ...account };
}

export function normalizeWorkspaceUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.search = "";
    url.hash = "";
    // Sabha's app page shows the API base URL (`…/api/v1`); accept it as the workspace URL.
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * A cable URL as configured or pasted from Sabha's app page. That page appends
 * `bot_key=<key>`; the plugin sends the key as a Bearer header instead, so the
 * parameter is dropped and the key never sits in a non-secret field or a log.
 * Other parameters (`wid` on sabha.co) are kept.
 */
export function normalizeCableUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return "";
    url.searchParams.delete("bot_key");
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Sabha's cable lives at /cable on the workspace host. On sabha.co the
 * workspace is a numeric path prefix for REST but a `wid` query parameter for
 * the cable, which never sits under the prefix.
 */
export function deriveCableUrl(workspaceUrl: string): string {
  if (!workspaceUrl) return "";
  const url = new URL(workspaceUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const prefix = url.pathname.replace(/\/+$/, "");
  const workspaceId = /^\/(\d{7,})$/.exec(prefix)?.[1];
  url.pathname = workspaceId ? "/cable" : `${prefix}/cable`;
  if (workspaceId) url.searchParams.set("wid", workspaceId);
  return url.toString();
}

export function resolveSabhaAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedSabhaAccount {
  const id = normalizeAccountId(accountId ?? resolveDefaultSabhaAccountId(cfg));
  const merged = mergeSabhaAccountConfig(cfg, id);
  const url = normalizeWorkspaceUrl(merged.url);
  const appKey = merged.appKey?.trim() ?? "";
  const cableUrl = normalizeCableUrl(merged.cableUrl) || deriveCableUrl(url);
  return {
    accountId: id,
    enabled: sabhaSection(cfg)?.enabled !== false && merged.enabled !== false,
    configured: Boolean(url && appKey),
    name: merged.name?.trim() || undefined,
    url,
    appKey,
    apiBaseUrl: url ? `${url}/api/v1` : "",
    cableUrl,
    dmPolicy: merged.dmPolicy ?? "open",
    allowFrom: (merged.allowFrom ?? []).map((entry) => entry.trim()).filter(Boolean),
    allowPrivateNetwork: merged.allowPrivateNetwork === true,
    replyToMode: merged.replyToMode ?? "first",
    // Opt-in until the Sabha server ships live drafts (AppEventsChannel#draft + client_message_id).
    livePreview: merged.livePreview === true,
    rooms: merged.rooms ?? {},
    config: merged,
  };
}

function credentialStatus(value: unknown): SabhaCredentialStatus {
  if (typeof value === "string" && value.trim()) return "available";
  return value === undefined ? "missing" : "configured_unavailable";
}

/**
 * Synchronous, secret-free snapshot for doctor/audit/status. Field names follow
 * the SDK's canonical credential-status keys (`tokenStatus`) so the shared
 * audit helpers see the app key.
 */
export function inspectSabhaAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveSabhaAccount(cfg, accountId);
  const tokenStatus = credentialStatus(account.config.appKey);
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    name: account.name,
    url: account.url,
    tokenStatus,
    tokenSource: tokenStatus === "missing" ? ("none" as const) : ("config" as const),
    urlStatus: account.url ? ("available" as const) : credentialStatus(account.config.url),
  };
}

export type InspectedSabhaAccount = ReturnType<typeof inspectSabhaAccount>;

export function listEnabledSabhaAccounts(cfg: OpenClawConfig): ResolvedSabhaAccount[] {
  return listSabhaAccountIds(cfg)
    .map((accountId) => resolveSabhaAccount(cfg, accountId))
    .filter((account) => account.enabled);
}

/** Write one account's fields. Setup and the CLI share this so both write the same shape. */
export function patchSabhaAccount(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<SabhaAccountConfig>,
): OpenClawConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const section = (channels.sabha ?? {}) as SabhaChannelConfig;
  const id = normalizeAccountId(accountId);
  const accounts = { ...(section.accounts ?? {}) };
  // Store what Sabha's app page shows in its canonical form; never the key inside the cable URL.
  const normalized = { ...patch };
  if (typeof patch.url === "string") normalized.url = normalizeWorkspaceUrl(patch.url) || patch.url;
  if (typeof patch.cableUrl === "string") normalized.cableUrl = normalizeCableUrl(patch.cableUrl) || patch.cableUrl.replace(/([?&])bot_key=[^&]*&?/, "$1").replace(/[?&]$/, "");
  accounts[id] = { ...(accounts[id] ?? {}), ...normalized, enabled: true };
  return { ...cfg, channels: { ...channels, sabha: { ...section, accounts } } } as OpenClawConfig;
}
