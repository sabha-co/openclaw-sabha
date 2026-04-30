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

// TEMP DEBUG (introduced post-2026.4.29 react/edit gate triage).
//
// Logs the agent's call shape at dispatch entry, the runner's
// `toolContext.currentChannelId` (which feeds the gate's auto-fill),
// and the dispatch outcome (success with resolved ids, or thrown
// error). Together these answer all the questions we kept re-deriving
// by reading `node_modules/openclaw/dist/*` line-by-line:
//
//   - what did the agent actually pass? (params shape)
//   - did the runner auto-fill `target`/`to`? (compare params.to to
//     toolContext.currentChannelId)
//   - which messageId did dispatch land on?
//   - what did the wire return? (3xx/4xx body, or the dispatch throw)
//
// Greppable as `[sabha-action]` in the gateway journal. Drop once the
// react/reactions surface is stable in production.
function previewParams(params: Record<string, unknown>): Record<string, unknown> {
  // Don't dump the full params (message bodies can be long, and we
  // don't want to leak attachment payloads into the journal). Surface
  // the gate-relevant keys and a short body preview.
  const out: Record<string, unknown> = {};
  for (const key of [
    "to",
    "target",
    "channel",
    "channelId",
    "channel_id",
    "roomId",
    "room_id",
    "messageId",
    "message_id",
    "emoji",
    "replyToId",
    "parentMessageId",
    "limit",
    "cursor",
  ]) {
    if (key in params) out[key] = params[key];
  }
  const message = params.message ?? params.text ?? params.body;
  if (typeof message === "string") {
    out.message_preview = message.length > 60
      ? `${message.slice(0, 60)}…(${message.length}ch)`
      : message;
  }
  return out;
}

function logActionEntry(ctx: ChannelMessageActionContext): void {
  const fields = previewParams(ctx.params);
  const tc = ctx.toolContext ?? {};
   
  console.log(
    `[sabha-action] enter action=${ctx.action} accountId=${ctx.accountId ?? "(default)"} ` +
      `currentChannelId=${tc.currentChannelId ?? "-"} currentMessageId=${tc.currentMessageId ?? "-"} ` +
      `replyToMode=${tc.replyToMode ?? "-"} params=${JSON.stringify(fields)}`,
  );
}

function logActionOk(
  ctx: ChannelMessageActionContext,
  details: Record<string, unknown>,
  startedAt: number,
): void {
   
  console.log(
    `[sabha-action] ok action=${ctx.action} elapsed=${Date.now() - startedAt}ms ` +
      `details=${JSON.stringify(details)}`,
  );
}

function logActionErr(
  ctx: ChannelMessageActionContext,
  err: unknown,
  startedAt: number,
): void {
  const message = err instanceof Error ? err.message : String(err);
   
  console.log(
    `[sabha-action] err action=${ctx.action} elapsed=${Date.now() - startedAt}ms ` +
      `error=${JSON.stringify(message)}`,
  );
}

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

// Project Sabha's wire shape into the field names the shared formatter
// (`openclaw/src/commands/message-format.ts`) reads. The formatter walks
// `payload.messages[]` and pulls `id` / `timestamp` / `authorTag` /
// `text`; rendering the raw `{ id, creator, body, attachment, created_at }`
// shape produces blank Time/Author/Text columns. Numeric ids are stringified
// because the formatter's user/author lookups gate on `typeof === "string"`.
// See docs/READ-AND-REACTIONS-ACTIONS-PLAN.md postscript.
function projectReadMessage(m: import("./types.js").SabhaReadMessage) {
  return {
    id: String(m.id),
    timestamp: m.created_at,
    author: { id: String(m.creator.id), username: m.creator.name },
    authorTag: m.creator.name,
    text: m.body.plain,
    attachment: m.attachment,
  };
}

// Same projection rationale as `projectReadMessage`. The formatter's
// reaction renderer reads `entry.name` for the emoji label and `entry.users`
// for booster identities (each entry stringly-keyed via `tag` / `username`
// / `id`). Sabha's wire `{ content, boosters: [{id: number, name}] }`
// would render as empty Emoji + empty Users without this remap.
function projectReaction(r: import("./types.js").SabhaReaction) {
  return {
    name: r.content,
    count: r.count,
    users: r.boosters.map((b) => ({ id: String(b.id), username: b.name })),
    truncated: r.truncated,
  };
}

export const sabhaMessageActions: ChannelMessageActionAdapter = {
  // describeMessageTool stays in channel.ts so the discovery half lives next
  // to the rest of the plugin definition. handleAction owns dispatch only.
  describeMessageTool: () => null,
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  handleAction: async (ctx) => {
    // TEMP DEBUG: log entry/outcome for every dispatch. See `previewParams`
    // / `logActionEntry` for the full rationale. Drop once stable.
    const __debugStart = Date.now();
    logActionEntry(ctx);
    try {
      const result = await dispatchSabhaAction(ctx);
      logActionOk(
        ctx,
        (result.details as Record<string, unknown> | undefined) ?? {},
        __debugStart,
      );
      return result;
    } catch (err) {
      logActionErr(ctx, err, __debugStart);
      throw err;
    }
  },
};

async function dispatchSabhaAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown>> {
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
      const messages = response.results.map(projectReadMessage);
      // "Newest first" baked into the note so the agent learns ordering
      // from the first call's tool result, regardless of which prompt-hint
      // slot is active for the current profile.
      const note = response.hasMore
        ? `Read ${messages.length} message(s), newest first (more available — pass cursor to walk)`
        : `Read ${messages.length} message(s), newest first`;
      return ok(note, {
        messages,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      });
    }

    if (action === "reactions") {
      // Id-only on the wire — server resolves the room from the message id.
      // 404 surfaces verbatim as SabhaApiError, matching member-info, and
      // collapses message-not-visible / message-not-found / soft-deleted.
      const messageId = readNumber(
        params,
        "messageId", "message_id", "targetMessageId",
      );
      if (messageId == null) {
        throw new Error("Sabha reactions requires 'messageId'.");
      }
      const response = await client.listReactions(messageId);
      const note = response.total === 0
        ? `No reactions on message ${messageId}`
        : `${response.total} reaction(s) on message ${messageId}`;
      return ok(note, {
        reactions: response.reactions.map(projectReaction),
        total: response.total,
        truncated: response.truncated,
      });
    }

    // Room-target resolution. Required for `send` and `thread-reply`
    // (the wire endpoint takes a room id in the URL path); optional for
    // the id-only verbs `edit` / `unsend` / `react` (the wire resolves
    // the room from the message id, so the agent can call them with
    // just `messageId` — matching how core's shared `message` tool
    // treats `messageId` as a valid target alias for those verbs).
    // When provided on an id-only call, the value is echoed back into
    // `details.roomId` for agent context but never sent on the wire.
    const roomId = readNumber(params, "to", "room_id", "roomId", "target");

    if (action === "send") {
      if (roomId == null) {
        throw new Error("Sabha send requires a numeric room target ('to' or 'room_id').");
      }
      const text = readString(params, "message", "text", "body");
      if (text == null) {
        throw new Error("Sabha send requires 'message' text.");
      }
      const replyToId = readNumber(params, "replyToId", "replyTo");
      const sent = await client.sendMessage(
        roomId,
        text,
        replyToId != null ? { parentMessageId: replyToId } : undefined,
      );
      // `sendMessage` returns null when neither the response body
      // (parentMessageId case) nor the Location header (regular case)
      // yields a usable id. The wire write succeeded but we can't
      // surface the resulting message id to the agent — fail loud
      // instead of returning `messageId: null`, which the agent might
      // chain on (e.g. `react messageId=null`).
      if (sent == null) {
        throw new Error("Sabha send: server returned no message id.");
      }
      if (replyToId != null) {
        return ok(`Replied to message ${replyToId}`, {
          messageId: sent.id,
          roomId: sent.roomId,
        });
      }
      return ok(`Sent message`, {
        messageId: sent.id,
        roomId: sent.roomId,
      });
    }

    if (action === "thread-reply") {
      if (roomId == null) {
        throw new Error("Sabha thread-reply requires a numeric room target ('to' or 'room_id').");
      }
      const text = readString(params, "message", "text", "body");
      const messageId = readNumber(params, "messageId", "message_id", "replyToId", "replyTo");
      if (text == null || messageId == null) {
        throw new Error("Sabha thread-reply requires 'message' and 'messageId'.");
      }
      const sent = await client.sendMessage(roomId, text, {
        parentMessageId: messageId,
      });
      if (sent == null) {
        throw new Error("Sabha thread-reply: server returned no message id.");
      }
      return ok(`Replied in thread on message ${messageId}`, {
        messageId: sent.id,
        roomId: sent.roomId,
      });
    }

    if (action === "edit") {
      const messageId = readNumber(params, "messageId", "message_id", "targetMessageId");
      const text = readString(params, "message", "text", "body");
      if (messageId == null || text == null) {
        throw new Error("Sabha edit requires 'messageId' and 'message'.");
      }
      await client.editMessage(messageId, text);
      return ok(`Edited message ${messageId}`, { messageId, roomId: roomId ?? null });
    }

    if (action === "unsend") {
      const messageId = readNumber(params, "messageId", "message_id", "targetMessageId");
      if (messageId == null) {
        throw new Error("Sabha unsend requires 'messageId'.");
      }
      await client.deleteMessage(messageId);
      return ok(`Deleted message ${messageId}`, { messageId, roomId: roomId ?? null });
    }

    if (action === "react") {
      const messageId = readNumber(params, "messageId", "message_id", "targetMessageId");
      const emoji = readString(params, "emoji", "emojiName", "reaction");
      if (messageId == null || emoji == null) {
        throw new Error("Sabha react requires 'messageId' and 'emoji'.");
      }
      const boostId = await client.addReaction(messageId, emoji);
      return ok(`Reacted with ${emoji} on message ${messageId}`, {
        boostId,
        messageId,
        roomId: roomId ?? null,
      });
    }

    throw new Error(`Unsupported Sabha message action: ${action}`);
}
