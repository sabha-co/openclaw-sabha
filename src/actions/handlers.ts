import type { ChannelMessageActionContext, ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { SabhaClient } from "../client/client.js";
import type { SabhaMessage, SabhaReactionGroup, SabhaSearchResult } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { sendSabhaMedia, sendSabhaText } from "../outbound/send.js";
import { resolveSendTarget } from "../outbound/target.js";
import { getSabhaRuntime } from "../runtime.js";
import { readId, readIds, readLimit, readText, requireValue } from "./params.js";

export type ActionDeps = { ctx: ChannelMessageActionContext; client: SabhaClient; account: ResolvedSabhaAccount };
export type ActionResult = Record<string, unknown>;

const MAX_PAGE = 200;

/** Revalidate the host's live authority immediately before a write. */
async function beforeWrite(ctx: ChannelMessageActionContext) {
  await ctx.onPlatformSendDispatch?.();
  ctx.assertDirectAdapterHandoff?.();
}

/** The named target, or the conversation this turn is in. */
function targetOf(ctx: ChannelMessageActionContext): string {
  const target = readText(ctx.params, "target", "to", "channelId", "channel_id", "roomId", "room_id") ?? ctx.toolContext?.currentChannelId;
  return requireValue(target, `Sabha ${ctx.action} needs a target room ('target').`);
}

async function roomOf(deps: ActionDeps): Promise<number> {
  return (await resolveSendTarget({ client: deps.client, to: targetOf(deps.ctx) })).roomId;
}

const messageIdOf = (ctx: ChannelMessageActionContext, required = true) => {
  const id = readId(ctx.params, "messageId", "message_id", "targetMessageId");
  return required ? requireValue(id, `Sabha ${ctx.action} needs 'messageId'.`) : id;
};

const textOf = (ctx: ChannelMessageActionContext) => readText(ctx.params, "message", "text", "body");

function projectMessage(message: SabhaMessage) {
  return {
    id: String(message.id),
    timestamp: message.created_at,
    author: { id: String(message.creator.id), username: message.creator.name },
    authorTag: message.creator.name,
    text: message.body.markdown || message.body.plain,
    ...(message.attachment ? { attachment: message.attachment } : {}),
    ...(message.thread ? { threadId: String(message.thread.id) } : {}),
  };
}

function projectSearchResult(result: SabhaSearchResult) {
  return {
    id: String(result.id),
    timestamp: result.created_at,
    author: { id: String(result.creator.id), username: result.creator.name },
    text: result.body.markdown || result.body.plain,
    room: { id: String(result.room.id), name: result.room.name },
  };
}

const projectReaction = (group: SabhaReactionGroup) => ({
  name: group.content,
  count: group.count,
  users: group.users.map((user) => ({ id: String(user.id), username: user.name })),
  truncated: group.truncated,
});

const handlers: Partial<Record<ChannelMessageActionName, (deps: ActionDeps) => Promise<ActionResult>>> = {
  send: async ({ ctx, client, account }) => {
    const text = textOf(ctx);
    const media = readText(ctx.params, "media", "mediaUrl", "filePath", "path");
    if (!text && !media) throw new Error("Sabha send needs 'message' text or 'media'.");
    const target = await resolveSendTarget({
      client,
      to: targetOf(ctx),
      threadId: readText(ctx.params, "threadId"),
      replyToId: readText(ctx.params, "replyToId", "replyTo"),
    });
    const sent = [];
    if (text) {
      await beforeWrite(ctx);
      sent.push(...(await sendSabhaText({ client, cfg: ctx.cfg, accountId: account.accountId, target, text })));
    }
    if (media) {
      await beforeWrite(ctx);
      sent.push(await sendSabhaMedia({ client, runtime: getSabhaRuntime(), account, target, url: media, ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}) }));
    }
    return {
      ok: true,
      messageId: String(sent[0]!.id),
      messageIds: sent.map((message) => String(message.id)),
      roomId: String(sent[0]!.roomId),
      ...(target.parentMessageId !== undefined ? { parentMessageId: String(target.parentMessageId) } : {}),
    };
  },

  "thread-reply": async ({ ctx, client, account }) => {
    const text = requireValue(textOf(ctx), "Sabha thread-reply needs 'message'.");
    const parent = requireValue(readId(ctx.params, "messageId", "message_id", "replyToId", "replyTo"), "Sabha thread-reply needs 'messageId' (the top-level message).");
    const roomId = await roomOf({ ctx, client, account });
    await beforeWrite(ctx);
    const sent = await sendSabhaText({ client, cfg: ctx.cfg, accountId: account.accountId, target: { roomId, parentMessageId: parent }, text });
    return { ok: true, messageId: String(sent[0]!.id), roomId: String(sent[0]!.roomId), parentMessageId: String(parent) };
  },

  edit: async ({ ctx, client }) => {
    const messageId = messageIdOf(ctx)!;
    const text = requireValue(textOf(ctx), "Sabha edit needs 'message'.");
    await beforeWrite(ctx);
    await client.editMessage(messageId, text);
    return { ok: true, messageId: String(messageId) };
  },

  unsend: async ({ ctx, client }) => {
    const messageId = messageIdOf(ctx)!;
    await beforeWrite(ctx);
    await client.deleteMessage(messageId);
    return { ok: true, messageId: String(messageId) };
  },

  react: async ({ ctx, client }) => {
    // Without an explicit id, react to the message this turn answers.
    const messageId = messageIdOf(ctx, false) ?? readId({ id: ctx.toolContext?.currentMessageId }, "id");
    const resolved = requireValue(messageId, "Sabha react needs 'messageId'.");
    if (ctx.params.remove === true) throw new Error("Sabha cannot remove reactions through the message tool yet.");
    const emoji = requireValue(readText(ctx.params, "emoji", "emojiName", "reaction"), "Sabha react needs 'emoji'.");
    await beforeWrite(ctx);
    const reactionId = await client.addReaction(resolved, emoji);
    return { ok: true, messageId: String(resolved), reactionId: String(reactionId), emoji };
  },

  reactions: async ({ ctx, client }) => {
    const messageId = messageIdOf(ctx)!;
    const result = await client.listReactions(messageId);
    return {
      ok: true,
      note: result.total === 0 ? `No reactions on message ${messageId}` : `${result.total} reaction(s) on message ${messageId}`,
      reactions: result.reactions.map(projectReaction),
      total: result.total,
      truncated: result.truncated,
    };
  },

  read: async (deps) => {
    const { ctx, client } = deps;
    const roomId = await roomOf(deps);
    const before = readText(ctx.params, "cursor", "before");
    const after = readText(ctx.params, "after");
    const limit = readLimit(ctx.params, MAX_PAGE);
    const page = await client.readMessages(roomId, { ...(before ? { before } : {}), ...(after ? { after } : {}), ...(limit ? { limit } : {}) });
    const messages = page.results.map(projectMessage);
    return {
      ok: true,
      note: `Read ${messages.length} message(s), newest first${page.hasMore ? " (more available: pass nextCursor as cursor)" : ""}`,
      messages,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  },

  search: async ({ ctx, client }) => {
    const query = requireValue(readText(ctx.params, "query", "q", "text"), "Sabha search needs 'query'.");
    const roomIds = readIds(ctx.params, ["channelIds", "channel_ids", "roomIds", "room_ids"], ["channelId", "channel_id", "roomId", "room_id"]);
    const authorIds = readIds(ctx.params, ["authorIds", "author_ids"], ["authorId", "author_id"]);
    const before = readText(ctx.params, "cursor", "before");
    const after = readText(ctx.params, "after");
    const limit = readLimit(ctx.params, MAX_PAGE);
    const page = await client.search({
      query,
      ...(roomIds ? { roomIds } : {}),
      ...(authorIds ? { authorIds } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(limit ? { limit } : {}),
    });
    return {
      ok: true,
      note: `Found ${page.results.length} result(s)${page.hasMore ? " (more available: pass nextCursor as cursor, or scope with channelIds/authorIds)" : ""}`,
      results: page.results.map(projectSearchResult),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  },

  "member-info": async ({ ctx, client }) => {
    const userId = requireValue(readId(ctx.params, "userId", "user_id", "memberId", "id"), "Sabha member-info needs 'userId'.");
    return { ok: true, profile: await client.getUser(userId) };
  },
};

export const SABHA_ACTIONS = Object.keys(handlers) as ChannelMessageActionName[];

export async function runSabhaAction(deps: ActionDeps): Promise<ActionResult> {
  const handler = handlers[deps.ctx.action];
  if (!handler) throw new Error(`Sabha does not support the '${deps.ctx.action}' action.`);
  return await handler(deps);
}
