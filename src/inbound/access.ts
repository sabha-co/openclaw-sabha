import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelIngressContextBinding,
  ChannelIngressEventInput,
  StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import type { SabhaChatType } from "../monitor/events.js";

/** Allowlist entries are Sabha user ids, optionally written `sabha:<id>` or `user:<id>`. */
export function normalizeSabhaUserEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed === "*") return "*";
  const id = trimmed.replace(/^(sabha|user):/i, "");
  return /^\d+$/.test(id) ? id : null;
}

export const sabhaIngressIdentity = {
  key: "sabha-user-id",
  // AppEventsChannel events are authenticated by the app key; Sabha owns user.id.
  authentication: "verified",
  normalize: normalizeSabhaUserEntry,
  isWildcardEntry: (entry) => entry.trim() === "*",
  resolveEntryId: ({ entryIndex }) => `sabha-entry-${entryIndex + 1}`,
} satisfies StableChannelIngressIdentityParams;

export async function resolveSabhaAccess(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  account: ResolvedSabhaAccount;
  senderId: number;
  roomId: string;
  threadId?: string;
  chatType: SabhaChatType;
  mentioned: boolean;
  /** Top-level group messages need a mention; DMs and threads don't. */
  requireMention: boolean;
  eventKind: ChannelIngressEventInput["kind"];
  hasControlCommand?: boolean;
  contextBinding?: ChannelIngressContextBinding;
}) {
  const { account } = params;
  const allowFrom = account.dmPolicy === "open" ? ["*"] : account.allowFrom;
  const isMessage = params.eventKind === "message";
  return await params.runtime.channel.inbound.ingress.resolveStable({
    channelId: "sabha",
    accountId: account.accountId,
    cfg: params.cfg,
    identity: sabhaIngressIdentity,
    ...(params.contextBinding ? { contextBinding: params.contextBinding } : {}),
    // Sabha has no pairing flow; access is the configured allowlist.
    useDefaultPairingStore: false,
    subject: { stableId: String(params.senderId) },
    conversation: { kind: params.chatType, id: params.roomId, ...(params.threadId ? { threadId: params.threadId } : {}) },
    event: { kind: params.eventKind, authMode: "inbound", mayPair: false },
    dmPolicy: account.dmPolicy,
    groupPolicy: "open",
    allowFrom,
    mentionFacts: { canDetectMention: true, wasMentioned: params.mentioned, hasAnyMention: params.mentioned },
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      ...(isMessage ? { activation: { requireMention: params.requireMention, allowTextCommands: true } } : {}),
    },
    command: isMessage
      ? {
          allowTextCommands: true,
          hasControlCommand: params.hasControlCommand === true,
          commandOwnerAllowFrom: account.allowFrom,
          groupOwnerAllowFrom: "none",
        }
      : false,
  });
}

export type SabhaAccess = Awaited<ReturnType<typeof resolveSabhaAccess>>;
