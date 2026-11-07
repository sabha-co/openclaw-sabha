import { buildChannelOutboundSessionRoute, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { SabhaChatType } from "./monitor/events.js";

/**
 * Sabha room ids are workspace-local, so group sessions include the account id
 * and DMs use one session per account and peer. A thread is its own room, so
 * thread events already carry the thread room id; `threadId` keeps the thread
 * visible to the host's thread bindings.
 */
export function buildSabhaSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId: string;
  roomId: string;
  chatType: SabhaChatType;
  threadId?: string;
}): ReturnType<typeof buildChannelOutboundSessionRoute> {
  return buildChannelOutboundSessionRoute({
    cfg: { ...params.cfg, session: { ...params.cfg.session, dmScope: "per-account-channel-peer", groupScope: "per-group" } },
    agentId: params.agentId,
    channel: "sabha",
    accountId: params.accountId,
    peer: { kind: params.chatType, id: params.chatType === "direct" ? params.roomId : `${params.accountId}:${params.roomId}` },
    chatType: params.chatType,
    from: `sabha:${params.roomId}`,
    to: params.roomId,
    threadId: params.threadId,
  });
}
