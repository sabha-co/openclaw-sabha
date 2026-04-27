import { ssrfPolicyFromAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  fetchRemoteMedia,
  type FetchLike,
} from "openclaw/plugin-sdk/media-runtime";

import type { ResolvedSabhaAccount } from "./accounts.js";

// Attachment fetches reach arbitrary URLs supplied by agents, Sabha signed
// URLs, or outbound media payloads. Route them through the SDK guard so
// loopback / RFC1918 / link-local / cloud-metadata targets are rejected
// before we open a socket. The SDK applies strict mode by default; this
// module only exists to translate the plugin's opt-in escape hatch
// (`allowPrivateAttachmentHosts: true`) into the SDK's policy shape and to
// give call sites a single import.
//
// The flag is resolved PER BOT ACCOUNT, not per base `channels.sabha`
// block, so a multi-bot deployment can keep strict mode on most accounts
// while one split-horizon DNS account opts in.

type AccountPolicyInput = Pick<
  ResolvedSabhaAccount,
  "allowPrivateAttachmentHosts"
>;

export function resolveAttachmentSsrfPolicy(
  account: AccountPolicyInput,
): SsrFPolicy | undefined {
  if (account.allowPrivateAttachmentHosts === true) {
    return ssrfPolicyFromAllowPrivateNetwork(true);
  }
  return undefined;
}

export type FetchGuardedAttachmentOptions = {
  url: string;
  account: AccountPolicyInput;
  fetchImpl?: FetchLike;
  maxBytes?: number;
};

export async function fetchGuardedAttachment(
  options: FetchGuardedAttachmentOptions,
): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
  const ssrfPolicy = resolveAttachmentSsrfPolicy(options.account);
  return await fetchRemoteMedia({
    url: options.url,
    fetchImpl: options.fetchImpl,
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(options.maxBytes != null ? { maxBytes: options.maxBytes } : {}),
  });
}
