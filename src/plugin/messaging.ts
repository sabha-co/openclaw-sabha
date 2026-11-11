// Target grammar and thread context for the shared `message` tool.
//
//   room   21 | channel:21 | room:21 | group:21 | #general (resolved by name)
//   user   user:5 | @{5} | @Ann (resolved by name)
//
// Room and user ids share one numeric space, so a bare number is a room.
// The client graph loads only inside the async lookups.
import type { ChannelThreadingToolContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveSabhaAccount } from "../config/accounts.js";
import { roomCanThread } from "../inbound/room-threading.js";
import { parseSabhaTarget } from "../outbound/target.js";
import { buildSabhaSessionRoute } from "../session.js";

export function normalizeSabhaTarget(raw: string): string | undefined {
  const value = raw.trim().replace(/^sabha:/i, "").trim();
  if (!value) return undefined;
  const mention = /^@\{(\d+)\}$/.exec(value);
  if (mention) return `user:${mention[1]}`;
  const kinded = /^(user|channel|room|group):(.*)$/i.exec(value);
  if (kinded) {
    const id = kinded[2]!.trim().replace(/^@\{(\d+)\}$/, "$1");
    if (!id) return undefined;
    return `${kinded[1]!.toLowerCase() === "user" ? "user" : "channel"}:${id}`;
  }
  if (value.startsWith("@")) return value.length > 1 ? `user:${value.slice(1).trim()}` : undefined;
  if (value.startsWith("#")) return value.length > 1 ? `channel:${value.slice(1).trim()}` : undefined;
  if (/^\d+$/.test(value)) return `channel:${value}`;
  return value;
}

/** Ids skip directory lookup; Sabha room ids are short, so the host's length heuristic would not. */
export function looksLikeSabhaTargetId(raw: string, normalized?: string): boolean {
  return [raw, normalized ?? ""].some((value) => /^(?:(?:user|channel):)?\d+$/i.test(value.trim()) || /^@\{\d+\}$/.test(value.trim()));
}

export function inferSabhaTargetChatType(to: string): "direct" | "group" | undefined {
  if (/^user:/i.test(to.trim())) return "direct";
  if (/^channel:/i.test(to.trim())) return "group";
  return undefined;
}

export async function resolveSabhaMessagingTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  normalized: string;
  preferredKind?: string;
}): Promise<{ to: string; kind: "user" | "group"; display?: string; source: "normalized" | "directory" } | null> {
  const kinded = /^(user|channel):(.*)$/i.exec(params.normalized);
  const kind = kinded ? (kinded[1]!.toLowerCase() === "user" ? "user" : "group") : params.preferredKind === "user" ? "user" : "group";
  const query = (kinded ? kinded[2]! : params.normalized).trim();
  if (!query) return null;
  const { resolveSabhaTargets } = await import("../directory.js");
  const [result] = await resolveSabhaTargets({ cfg: params.cfg, accountId: params.accountId, inputs: [query], kind });
  if (!result?.resolved || !result.id) return null;
  return {
    to: `${kind === "user" ? "user" : "channel"}:${result.id}`,
    kind,
    ...(result.name ? { display: result.name } : {}),
    source: /^\d+$/.test(query) ? "normalized" : "directory",
  };
}

/** A thread is its own room, so a thread session delivers straight into it. */
export function resolveSabhaDeliveryTarget(params: { conversationId: string }): { to: string } | null {
  const roomId = params.conversationId.trim().replace(/^[^:]+:(\d+)$/, "$1");
  return /^\d+$/.test(roomId) ? { to: `channel:${roomId}` } : null;
}

export async function resolveSabhaOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  currentSessionKey?: string;
  resolvedTarget?: { to: string; kind: string };
  threadId?: string | number | null;
}): Promise<ReturnType<typeof buildSabhaSessionRoute> | null> {
  const parsed = parseSabhaTarget(params.resolvedTarget?.to ?? params.target);
  if (!parsed) return null;
  const account = resolveSabhaAccount(params.cfg, params.accountId);
  if (parsed.kind === "user") {
    // DM sessions are keyed by the DM room, the same key inbound DMs use.
    const { accountClient } = await import("../client/account-client.js");
    let roomId: number;
    try {
      roomId = (await accountClient(params.cfg, account.accountId).client.createDm([parsed.id])).roomId;
    } catch {
      return null;
    }
    return buildSabhaSessionRoute({ cfg: params.cfg, agentId: params.agentId, accountId: account.accountId, roomId: String(roomId), chatType: "direct" });
  }
  // A thread is its own room and sends with a threadId land there (see
  // resolveSendTarget), so the session is the thread room's, as for inbound.
  const threadId = params.threadId != null && /^\d+$/.test(String(params.threadId)) ? String(params.threadId) : undefined;
  const roomId = threadId ?? String(parsed.id);
  const direct = buildSabhaSessionRoute({ cfg: params.cfg, agentId: params.agentId, accountId: account.accountId, roomId, chatType: "direct" });
  if (params.currentSessionKey === direct.sessionKey) return direct;
  return buildSabhaSessionRoute({ cfg: params.cfg, agentId: params.agentId, accountId: account.accountId, roomId, chatType: "group", ...(threadId ? { threadId } : {}) });
}

/**
 * Thread context for message-tool sends. Top-level group turns carry the
 * account's replyToMode so the host threads the first reply under the
 * inbound message. In a thread or DM (group DMs included) the current room is
 * already the right place, so replyToMode is off: threading again would nest
 * a thread, and Sabha refuses threads in DMs.
 */
export function buildSabhaThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: { To?: string; ChatType?: string; CurrentMessageId?: string | number; MessageThreadId?: string | number; NativeChannelId?: string };
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const { context } = params;
  const account = resolveSabhaAccount(params.cfg, params.accountId);
  const inThread = context.MessageThreadId != null;
  const isDm = context.ChatType === "direct";
  // The turn reports its room bare ("21"), but a read's target reaches the
  // host's exact-current check as "channel:21", and a typed target never
  // matches an untyped current room. Report the room the way targets read.
  const rawTo = context.To?.trim();
  const to = rawTo ? (normalizeSabhaTarget(rawTo) ?? rawTo) : undefined;
  // Group DMs report ChatType "group" but can't hold threads; the inbound turn recorded the room's kind.
  const roomId = (context.NativeChannelId ?? to ?? "").replace(/^(?:sabha:)?(?:channel:|room:|group:)?/i, "");
  const cannotThread = /^\d+$/.test(roomId) && roomCanThread(account.accountId, roomId) === false;
  return {
    ...(to ? { currentChannelId: to } : {}),
    ...(context.CurrentMessageId != null ? { currentMessageId: context.CurrentMessageId } : {}),
    ...(inThread ? { currentThreadTs: String(context.MessageThreadId) } : {}),
    replyToMode: inThread || isDm || cannotThread ? "off" : account.replyToMode,
    ...(params.hasRepliedRef ? { hasRepliedRef: params.hasRepliedRef } : {}),
  };
}
