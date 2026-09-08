import { buildChannelOutboundSessionRoute, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { SabhaMessageEventPayload } from "./types.js";

/** Thread events already name the thread room; the payload has no parent room id. */
export function resolveSessionFromPayload(payload: SabhaMessageEventPayload) {
  return {
    chatType: payload.room.type === "Direct" ? "direct" as const : "group" as const,
    conversationId: String(payload.room.id),
    threadId: payload.message.thread ? String(payload.message.thread.id) : undefined,
  };
}

/** Sabha room ids are tenant-local, so every session includes the bot account. */
export function buildSabhaSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId: string;
  roomId: string;
  chatType: "direct" | "group";
  threadId?: string;
}): ReturnType<typeof buildChannelOutboundSessionRoute> {
  return buildChannelOutboundSessionRoute({
    cfg: { ...params.cfg, session: { ...params.cfg.session, dmScope: "per-account-channel-peer", groupScope: "per-group" } },
    agentId: params.agentId, channel: "sabha", accountId: params.accountId,
    peer: { kind: params.chatType, id: params.chatType === "direct" ? params.roomId : `${params.accountId}:${params.roomId}` },
    chatType: params.chatType, from: `sabha:${params.roomId}`, to: params.roomId,
    threadId: params.threadId,
  });
}
