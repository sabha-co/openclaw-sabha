import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";

import {
  resolveDefaultSabhaAccountId,
} from "./accounts.js";
import { setSabhaAccountConfig } from "./setup-wizard.js";

// Setup-promotion contract consumed by the SDK's setup wizard
// (`setup-wizard-helpers-*.js` calls
// `moveSingleAccountChannelSectionToDefaultAccount` during
// `openclaw configure` to canonicalize the file shape when an operator
// runs setup against a legacy single-account config).
//
// The SDK ships a static `COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE` set
// (`dmPolicy`, `allowFrom`, plus generic auth keys like `token`/`accessToken`)
// — anything Sabha-specific must be declared here or the wizard's
// promotion step won't move it. See
// `openclaw/src/channels/plugins/setup-promotion-helpers.ts`.

/**
 * Every per-account field that the setup wizard should promote out of
 * the base block when no named accounts exist (single-bot legacy shape →
 * canonical `accounts.default` shape). Excludes channel-level keys
 * (`enabled`, `accounts`, `defaultAccount`) — the SDK helper filters
 * those automatically.
 *
 * Static-set keys (`dmPolicy`, `allowFrom`) are omitted because the SDK
 * already promotes them; listing them again is harmless but adds noise.
 *
 * Schema-defaulted keys (`typingEnabled`, `replyToMode`) are deliberately
 * NOT listed. The helper sees the post-default in-memory config, so
 * listing them would make the wizard "promote" defaults that were never
 * on disk, churning the file shape during setup. Behavioral defaults
 * with `default:` in the schema can never appear at the base block on
 * disk in a post-rename install — there is nothing to migrate.
 */
export const sabhaSingleAccountKeysToMove = [
  "baseUrl",
  "apiBaseUrl",
  "botKey",
  "botName",
  "websocketUrl",
  "rooms",
  "allowPrivateAttachmentHosts",
] as const;

/**
 * When named accounts already exist (e.g. operator added `accounts.staging`
 * but legacy creds still sit at the channel root), the setup wizard's
 * promotion step only moves keys in *this* list into `accounts.default`.
 * The rest stay at the base block and continue to layer through
 * `mergeSabhaAccountConfig` into every account.
 *
 * Listed: per-account credentials and identity. These are the fields a
 * second bot must NOT silently inherit from a stray base-level value —
 * a base-level `botKey` getting picked up by `accounts.staging` is the
 * exact silent-leak footgun this list closes.
 *
 * Not listed: `baseUrl` / `apiBaseUrl` (often workspace-shared in
 * multi-bot tenants), behavioral defaults (`replyToMode`, `dmPolicy`,
 * `typingEnabled`, `allowPrivateAttachmentHosts`, `rooms`, `allowFrom`).
 * These can stay shared without surprising any named account.
 */
export const sabhaNamedAccountPromotionKeys = [
  "botKey",
  "botName",
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
