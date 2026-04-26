import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  listBotAccountIds,
  mergeBotAccountConfig,
  resolveDefaultBotAccountId,
} from "./bot-accounts.js";
import type { SabhaConfig } from "./types.js";

export type SabhaCredentialStatus = "available" | "configured_unavailable" | "missing";
export type SabhaCredentialSource = "config" | "none";

/**
 * Read-only snapshot of a single bot account, used by the OpenClaw doctor /
 * audit-channel layer (`openclaw/src/security/audit-channel.ts`) to surface
 * per-account configuration state without booting the runtime.
 *
 * Mirrors the shape used by `extensions/{slack,discord,telegram}/src/account-inspect.ts`,
 * Sabha-tailored:
 *   - No env-var resolution path. Sabha bot keys live only in
 *     `botAccounts.<id>.botKey`; there is no `SABHA_BOT_KEY`-style fallback.
 *   - No `tokenFile` indirection. Same reason.
 *   - Bot keys are plain strings, not `SecretRef` objects, so the tri-state
 *     check is a direct undefined/empty/non-empty discriminant on the raw
 *     merged config field rather than going through `coerceSecretRef`.
 *   - `webhookSecret` is only surfaced when `connectionMode === "webhook"`;
 *     in WS mode the secret is captured but unused, so audit shouldn't flag
 *     its absence.
 */
export type InspectedSabhaAccount = {
  accountId: string;
  enabled: boolean;
  /** Bot display name (defaults to `"OpenClaw"` when unset). */
  name: string;
  /** Inbound transport: WS (default) connects outbound; webhook needs inbound reachability. */
  mode: "websocket" | "webhook";
  baseUrl: string;
  apiBaseUrl: string;
  botKeyStatus: SabhaCredentialStatus;
  botKeySource: SabhaCredentialSource;
  /** Only present in webhook mode; in WS mode the secret is captured but unused. */
  webhookSecretStatus?: SabhaCredentialStatus;
  webhookSecretSource?: SabhaCredentialSource;
  baseUrlStatus: SabhaCredentialStatus;
  apiBaseUrlStatus: SabhaCredentialStatus;
  /** True when every credential the runtime needs is `"available"`. Audit reads this. */
  configured: boolean;
  /** Full merged config so audit can read other resolved fields without a second pass. */
  config: SabhaConfig;
};

function inspectStringField(value: unknown): {
  status: SabhaCredentialStatus;
  source: SabhaCredentialSource;
} {
  if (typeof value === "string" && value.length > 0) {
    return { status: "available", source: "config" };
  }
  if (value === "") {
    return { status: "configured_unavailable", source: "config" };
  }
  return { status: "missing", source: "none" };
}

function inspectSabhaAccountPrimary(
  cfg: OpenClawConfig,
  accountId: string,
): InspectedSabhaAccount {
  const merged = mergeBotAccountConfig(cfg, accountId);
  const sabhaSection = (cfg.channels as Record<string, unknown> | undefined)?.sabha as
    | SabhaConfig
    | undefined;

  const baseEnabled = sabhaSection?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const baseUrl = inspectStringField(merged.baseUrl);
  const apiBaseUrl = inspectStringField(merged.apiBaseUrl);
  const botKey = inspectStringField(merged.botKey);

  const mode = (merged.connectionMode ?? "websocket") as "websocket" | "webhook";
  const isWebhookMode = mode === "webhook";

  const webhookSecret = isWebhookMode ? inspectStringField(merged.webhookSecret) : null;

  const configured =
    baseUrl.status === "available" &&
    apiBaseUrl.status === "available" &&
    botKey.status === "available" &&
    (!isWebhookMode || webhookSecret?.status === "available");

  return {
    accountId,
    enabled,
    name: merged.botName?.trim() || "OpenClaw",
    mode,
    baseUrl: typeof merged.baseUrl === "string" ? merged.baseUrl : "",
    apiBaseUrl: typeof merged.apiBaseUrl === "string" ? merged.apiBaseUrl : "",
    botKeyStatus: botKey.status,
    botKeySource: botKey.source,
    ...(webhookSecret
      ? {
          webhookSecretStatus: webhookSecret.status,
          webhookSecretSource: webhookSecret.source,
        }
      : {}),
    baseUrlStatus: baseUrl.status,
    apiBaseUrlStatus: apiBaseUrl.status,
    configured,
    config: merged,
  };
}

/**
 * Resolve the inspected account for `accountId`, falling back to the default
 * account id when omitted/nullish. Mirrors `resolveBotAccount`'s fallback
 * semantics so audit + runtime see the same account selection.
 */
export function inspectSabhaAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedSabhaAccount {
  const accountId =
    params.accountId && params.accountId.length > 0
      ? params.accountId
      : resolveDefaultBotAccountId(params.cfg);
  return inspectSabhaAccountPrimary(params.cfg, accountId);
}

/**
 * Inspect every configured bot account. Useful for `openclaw doctor`-style
 * surfaces that want a per-account row without knowing the id list up front.
 */
export function inspectAllSabhaAccounts(cfg: OpenClawConfig): InspectedSabhaAccount[] {
  return listBotAccountIds(cfg).map((accountId) =>
    inspectSabhaAccountPrimary(cfg, accountId),
  );
}
