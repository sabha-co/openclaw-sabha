import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";

import {
  resolveDefaultSabhaAccountId,
} from "./accounts.js";
import { setSabhaAccountConfig } from "./setup-wizard.js";

// Setup-promotion contract for the SDK's
// `moveSingleAccountChannelSectionToDefaultAccount` migration helper.
//
// The SDK ships a static `COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE` set
// (`webhookSecret`, `dmPolicy`, `allowFrom`, plus generic auth keys like
// `token`/`accessToken`) — anything Sabha-specific must be declared here
// or the migration shim won't promote it. See
// `openclaw/src/channels/plugins/setup-promotion-helpers.ts`.

/**
 * Every per-account field that the migration shim should promote out of
 * the base block when no named accounts exist (single-bot legacy shape →
 * canonical `accounts.default` shape). Excludes channel-level keys
 * (`enabled`, `accounts`, `defaultAccount`) — the SDK helper filters
 * those automatically.
 *
 * Static-set keys (`webhookSecret`, `dmPolicy`, `allowFrom`) are omitted
 * because the SDK already promotes them; listing them again is harmless
 * but adds noise.
 */
export const sabhaSingleAccountKeysToMove = [
  "baseUrl",
  "apiBaseUrl",
  "botKey",
  "botName",
  "connectionMode",
  "websocketUrl",
  "webhookPort",
  "typingEnabled",
  "replyToMode",
  "rooms",
  "allowPrivateAttachmentHosts",
] as const;

/**
 * When named accounts already exist (e.g. operator added `accounts.staging`
 * but legacy creds still sit at the channel root), the migration shim
 * only promotes keys in *this* list into `accounts.default`. The rest
 * stay at the base block and continue to layer through
 * `mergeSabhaAccountConfig` into every account.
 *
 * Listed: per-account credentials and identity. These are the fields a
 * second bot must NOT silently inherit from a stray base-level value —
 * a base-level `botKey` getting picked up by `accounts.staging` is the
 * exact silent-leak footgun the migration shim is meant to close.
 *
 * Not listed: `baseUrl` / `apiBaseUrl` (often workspace-shared in
 * multi-bot tenants), behavioral defaults (`replyToMode`, `dmPolicy`,
 * `typingEnabled`, `connectionMode`, `webhookPort`,
 * `allowPrivateAttachmentHosts`, `rooms`, `allowFrom`). These can stay
 * shared without surprising any named account.
 */
export const sabhaNamedAccountPromotionKeys = [
  "botKey",
  "botName",
  "webhookSecret",
  "websocketUrl",
] as const;

/**
 * Minimal `ChannelSetupAdapter` for the SDK's `openclaw channels add` /
 * `openclaw configure` flows. The interactive wizard
 * (`sabhaSetupWizard.finalize` in `setup-wizard.ts`) is the path that
 * actually fills in per-account fields like `botKey`; this adapter only
 * needs to canonicalize the location and toggle `enabled: true`.
 *
 * Mirrors Feishu's `feishuSetupAdapter` shape — both delegate the heavy
 * lifting to the wizard.
 */
export const sabhaSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) =>
    accountId?.trim() || resolveDefaultSabhaAccountId(cfg),
  applyAccountConfig: ({ cfg, accountId }) =>
    setSabhaAccountConfig(cfg, accountId, {}),
};
