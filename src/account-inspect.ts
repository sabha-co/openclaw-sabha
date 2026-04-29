import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  listSabhaAccountIds,
  mergeSabhaAccountConfig,
  resolveDefaultSabhaAccountId,
} from "./accounts.js";
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
 *     `accounts.<id>.botKey`; there is no `SABHA_BOT_KEY`-style fallback.
 *   - No `tokenFile` indirection. Same reason.
 *   - Bot keys are plain strings, not `SecretRef` objects, so the tri-state
 *     check is a direct undefined/empty/non-empty discriminant on the raw
 *     merged config field rather than going through `coerceSecretRef`.
 * **Field naming follows the SDK's canonical credential-status keys**
 * (`tokenStatus`) so the shared runtime helpers in
 * `openclaw/src/channels/account-snapshot-fields.ts` (closed set:
 * `tokenStatus`/`botTokenStatus`/`appTokenStatus`/`signingSecretStatus`/`userTokenStatus`)
 * can pick them up. Using a Sabha-flavored name like `botKeyStatus` would
 * be invisible to `hasConfiguredUnavailableCredentialStatus`,
 * `projectCredentialSnapshotFields`, and the audit channel's "configured
 * but unavailable" warnings. `tokenStatus` reflects `botKey`.
 */
export type InspectedSabhaAccount = {
  accountId: string;
  enabled: boolean;
  /** Bot display name (defaults to `"OpenClaw"` when unset). */
  name: string;
  baseUrl: string;
  apiBaseUrl: string;
  /** Status of the `botKey` credential. Canonical SDK key — read by audit/status helpers. */
  tokenStatus: SabhaCredentialStatus;
  tokenSource: SabhaCredentialSource;
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
  const merged = mergeSabhaAccountConfig(cfg, accountId);
  const sabhaSection = (cfg.channels as Record<string, unknown> | undefined)?.sabha as
    | SabhaConfig
    | undefined;

  const baseEnabled = sabhaSection?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const baseUrl = inspectStringField(merged.baseUrl);
  const apiBaseUrl = inspectStringField(merged.apiBaseUrl);
  const botKey = inspectStringField(merged.botKey);

  const configured =
    baseUrl.status === "available" &&
    apiBaseUrl.status === "available" &&
    botKey.status === "available";

  return {
    accountId,
    enabled,
    name: merged.botName?.trim() || "OpenClaw",
    baseUrl: typeof merged.baseUrl === "string" ? merged.baseUrl : "",
    apiBaseUrl: typeof merged.apiBaseUrl === "string" ? merged.apiBaseUrl : "",
    tokenStatus: botKey.status,
    tokenSource: botKey.source,
    baseUrlStatus: baseUrl.status,
    apiBaseUrlStatus: apiBaseUrl.status,
    configured,
    config: merged,
  };
}

/**
 * Resolve the inspected account for `accountId`, falling back to the default
 * account id when omitted/nullish. Mirrors `resolveSabhaAccount`'s fallback
 * semantics so audit + runtime see the same account selection.
 */
export function inspectSabhaAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedSabhaAccount {
  const accountId =
    params.accountId && params.accountId.length > 0
      ? params.accountId
      : resolveDefaultSabhaAccountId(params.cfg);
  return inspectSabhaAccountPrimary(params.cfg, accountId);
}

/**
 * Inspect every configured bot account. Useful for `openclaw doctor`-style
 * surfaces that want a per-account row without knowing the id list up front.
 */
export function inspectAllSabhaAccounts(cfg: OpenClawConfig): InspectedSabhaAccount[] {
  return listSabhaAccountIds(cfg).map((accountId) =>
    inspectSabhaAccountPrimary(cfg, accountId),
  );
}
