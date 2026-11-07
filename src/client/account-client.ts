import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveSabhaAccount, type ResolvedSabhaAccount } from "../config/accounts.js";
import { SabhaClient } from "./client.js";

export class SabhaAccountUnavailableError extends Error {
  constructor(account: Pick<ResolvedSabhaAccount, "accountId" | "enabled">) {
    super(
      account.enabled
        ? `Sabha account "${account.accountId}" is not configured (set channels.sabha.accounts.${account.accountId}.url and appKey)`
        : `Sabha account "${account.accountId}" is disabled`,
    );
    this.name = "SabhaAccountUnavailableError";
  }
}

export function clientFor(account: ResolvedSabhaAccount, abortSignal?: AbortSignal): SabhaClient {
  if (!account.enabled || !account.configured) throw new SabhaAccountUnavailableError(account);
  return new SabhaClient({ apiBaseUrl: account.apiBaseUrl, appKey: account.appKey, ...(abortSignal ? { abortSignal } : {}) });
}

/** The account comes from host context (cfg + accountId), never from model params. */
export function accountClient(cfg: OpenClawConfig, accountId?: string | null, abortSignal?: AbortSignal) {
  const account = resolveSabhaAccount(cfg, accountId);
  return { account, client: clientFor(account, abortSignal) };
}
