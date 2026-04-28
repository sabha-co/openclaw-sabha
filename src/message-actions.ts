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
  "read",
  "reactions",
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

/**
 * Parse a numeric-array param. Accepts either a real array (`[1, 2, 3]`)
 * or a CSV string (`"1,2,3"`) — agents trained on REST APIs often emit
 * the comma form even when the schema asks for an array.
 */
function readNumberArray(
  params: Record<string, unknown>,
  ...keys: string[]
): number[] | undefined {
  for (const k of keys) {
    const v = params[k];
    if (Array.isArray(v)) {
      const nums = v
        .map((x) => (typeof x === "number" ? x : Number(x)))
        .filter((n) => Number.isFinite(n));
      if (nums.length > 0) return nums;
    }
    if (typeof v === "string" && v.trim()) {
      const nums = v
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      if (nums.length > 0) return nums;
    }
  }
  return undefined;
}

/**
 * Merge an arbitrary set of plural and singular keys into a single number
 * list. The canonical message-tool schema exposes both forms (e.g.
 * `channelId` + `channelIds`, `authorId` + `authorIds`); peers union the
 * two so callers can use either. Sabha rooms ARE channels in the cross-
 * channel sense, so `channelId` / `channelIds` map onto the same wire
 * field as Sabha's own `roomId` / `roomIds` aliases.
 */
function readNumberList(
  params: Record<string, unknown>,
  pluralKeys: string[],
  singularKeys: string[],
): number[] | undefined {
  const merged: number[] = [];
  for (const k of pluralKeys) {
    const arr = readNumberArray(params, k);
    if (arr) merged.push(...arr);
  }
  for (const k of singularKeys) {
    const n = readNumber(params, k);
    if (n != null) merged.push(n);
  }
  return merged.length > 0 ? merged : undefined;
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
      const response = await client.search({
        query,
        // Canonical message-tool schema exposes channelId/channelIds and
        // authorId/authorIds (plural and singular). Sabha rooms are
        // channels in the cross-channel sense — without these aliases,
        // a caller using the standard fields would have their scope
        // silently dropped and run a workspace-wide search.
        roomIds: readNumberList(
          params,
          ["channelIds", "channel_ids", "roomIds", "room_ids"],
          ["channelId", "channel_id", "roomId", "room_id"],
        ),
        authorIds: readNumberList(
          params,
          ["authorIds", "author_ids"],
          ["authorId", "author_id"],
        ),
        before: readString(params, "before"),
        after: readString(params, "after"),
        limit: readNumber(params, "limit"),
        cursor: readString(params, "cursor"),
      });
      // The agent reads `hasMore` to decide whether to refine vs. paginate;
      // `nextCursor` lets it walk if it really needs more.
      const note = response.hasMore
        ? `Found ${response.results.length} (more available — pass cursor to walk or scope with channelIds/authorIds)`
        : `Found ${response.results.length} result(s)`;
      return ok(note, {
        results: response.results,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      });
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

    if (action === "read") {
      // Single-room read. Match the canonical message-tool field naming
      // (`channelId` first) so a cross-channel agent's natural call works
      // verbatim — Sabha rooms ARE channels in the cross-channel sense.
      // Same precedent as `search` above (which uses `readNumberList` for
      // its multi-room scoping).
      const roomId = readNumber(
        params,
        "channelId", "channel_id", "roomId", "room_id", "to", "target",
      );
      if (roomId == null) {
        throw new Error(
          "Sabha read requires a single room target ('channelId' or 'roomId').",
        );
      }
      const response = await client.readMessages({
        roomId,
        before: readString(params, "before"),
        after: readString(params, "after"),
        limit: readNumber(params, "limit"),
        cursor: readString(params, "cursor"),
      });
      // "Newest first" baked into the note so the agent learns ordering
      // from the first call's tool result, regardless of which prompt-hint
      // slot is active for the current profile.
      const note = response.hasMore
        ? `Read ${response.results.length} message(s), newest first (more available — pass cursor to walk)`
        : `Read ${response.results.length} message(s), newest first`;
      return ok(note, {
        results: response.results,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      });
    }

    if (action === "reactions") {
      // Per-message lookup. Server returns 404 indistinguishably for
      // wrong-room, wrong-message-id, and soft-deleted (messages.active
      // scope) — surfaces verbatim as SabhaApiError, matching member-info.
      const roomId = readNumber(
        params,
        "channelId", "channel_id", "roomId", "room_id", "to", "target",
      );
      const messageId = readNumber(
        params,
        "messageId", "message_id", "targetMessageId",
      );
      // Two `throw`s rather than a combined disjunctive message so each
      // missing-field case can be tested specifically (the regex form
      // matches either branch and tells you nothing).
      if (roomId == null) {
        throw new Error(
          "Sabha reactions requires a single room target ('channelId' or 'roomId').",
        );
      }
      if (messageId == null) {
        throw new Error("Sabha reactions requires 'messageId'.");
      }
      const response = await client.listReactions(roomId, messageId);
      const note = response.total === 0
        ? `No reactions on message ${messageId}`
        : `${response.total} reaction(s) on message ${messageId}`;
      return ok(note, response);
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
