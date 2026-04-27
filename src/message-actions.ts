import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { SabhaClient } from "./client.js";
import { resolveSabhaAccount } from "./accounts.js";

/**
 * Channel-owned action surface for the shared `message` tool.
 *
 * The discovery half — which actions exist — is declared on `actions.describeMessageTool`
 * in `channel.ts`. This module is the dispatch half: when core's shared `message` tool
 * resolves an action to Sabha, `handleAction` here parses params, calls the
 * matching `SabhaClient` method, and returns an `AgentToolResult`.
 *
 * Reply pipeline (`outbound.attachedResults.sendText`) coexists with this: that
 * path is driven by inbound events; this path is driven by the agent calling
 * `message` with an explicit `action`.
 */

// `reply` is intentionally absent. `send` with `replyToId` covers the
// "reply" semantic, and `thread-reply` covers explicit-target replies
// that fail closed if `messageId` is missing. Exposing `reply` as a
// separate action would either be redundant with `send` or duplicate
// `thread-reply` — peers (Mattermost) don't expose it for the same
// reason.
const SUPPORTED_ACTIONS: ReadonlySet<ChannelMessageActionName> = new Set([
  "send",
  "edit",
  "unsend",
  "react",
  "thread-reply",
  "search",
  "member-info",
]);

function buildClient(ctx: ChannelMessageActionContext): SabhaClient {
  const account = resolveSabhaAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  if (!account.enabled) {
    throw new Error(
      `Sabha bot account "${account.accountId}" is disabled (channels.sabha.accounts.${account.accountId}.enabled === false).`,
    );
  }
  if (!account.apiBaseUrl || !account.botKey) {
    throw new Error(
      `Sabha bot account "${account.accountId}" is missing apiBaseUrl or botKey.`,
    );
  }
  return new SabhaClient(account.apiBaseUrl, account.botKey);
}

function readString(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function readNumber(params: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function ok(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export const sabhaMessageActions: ChannelMessageActionAdapter = {
  // describeMessageTool stays in channel.ts so the discovery half lives next
  // to the rest of the plugin definition. handleAction owns dispatch only.
  describeMessageTool: () => null,
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  handleAction: async (ctx) => {
    const { action, params } = ctx;
    const client = buildClient(ctx);

    if (action === "search") {
      const query = readString(params, "query", "q", "text");
      if (!query) {
        throw new Error("Sabha search requires a 'query' parameter.");
      }
      const results = await client.search(query);
      return ok(`Found ${results.length} result(s)`, { results });
    }

    if (action === "member-info") {
      // Profile lookup is workspace-scoped (no room required). Server
      // returns 404 if the bot can't see the user (`visible_users` /
      // `User.sharing_rooms_with`); the SabhaApiError surfaces back to
      // the agent unchanged.
      const userId = readNumber(params, "userId", "user_id", "id", "memberId");
      if (userId == null) {
        throw new Error("Sabha member-info requires 'userId'.");
      }
      const profile = await client.getUser(userId);
      return ok(`Profile for ${profile.name} (id ${profile.id})`, { profile });
    }

    const roomId = readNumber(params, "to", "room_id", "roomId", "target");
    if (roomId == null) {
      throw new Error(`Sabha ${action} requires a numeric room target ('to' or 'room_id').`);
    }

    if (action === "send") {
      const text = readString(params, "message", "text", "body");
      if (text == null) {
        throw new Error("Sabha send requires 'message' text.");
      }
      const replyToId = readNumber(params, "replyToId", "replyTo");
      if (replyToId != null) {
        const result = await client.replyInThread(roomId, replyToId, text);
        return ok(`Replied to message ${replyToId}`, {
          messageId: result.message.id,
          roomId,
        });
      }
      const messageId = await client.sendMessage(roomId, text);
      return ok(`Sent message`, { messageId, roomId });
    }

    if (action === "thread-reply") {
      const text = readString(params, "message", "text", "body");
      const messageId = readNumber(params, "messageId", "message_id", "replyToId", "replyTo");
      if (text == null || messageId == null) {
        throw new Error("Sabha thread-reply requires 'message' and 'messageId'.");
      }
      const result = await client.replyInThread(roomId, messageId, text);
      return ok(`Replied in thread on message ${messageId}`, {
        messageId: result.message.id,
        roomId,
      });
    }

    if (action === "edit") {
      const messageId = readNumber(params, "messageId", "message_id", "targetMessageId");
      const text = readString(params, "message", "text", "body");
      if (messageId == null || text == null) {
        throw new Error("Sabha edit requires 'messageId' and 'message'.");
      }
      await client.editMessage(roomId, messageId, text);
      return ok(`Edited message ${messageId}`, { messageId, roomId });
    }

    if (action === "unsend") {
      const messageId = readNumber(params, "messageId", "message_id", "targetMessageId");
      if (messageId == null) {
        throw new Error("Sabha unsend requires 'messageId'.");
      }
      await client.deleteMessage(roomId, messageId);
      return ok(`Deleted message ${messageId}`, { messageId, roomId });
    }

    if (action === "react") {
      const messageId = readNumber(params, "messageId", "message_id", "targetMessageId");
      const emoji = readString(params, "emoji", "emojiName", "reaction");
      if (messageId == null || emoji == null) {
        throw new Error("Sabha react requires 'messageId' and 'emoji'.");
      }
      const boostId = await client.addReaction(roomId, messageId, emoji);
      return ok(`Reacted with ${emoji} on message ${messageId}`, {
        boostId,
        messageId,
        roomId,
      });
    }

    throw new Error(`Unsupported Sabha message action: ${action}`);
  },
};
