import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";

import type { SabhaAccount, SabhaConfig } from "./types.js";
import { SabhaClient, extractBotId } from "./client.js";
import { resolveSessionConversation } from "./session.js";

function resolveAccount(
  cfg: any,
  accountId?: string | null,
): SabhaAccount {
  const section = (cfg.channels as Record<string, any>)?.sabha as
    | SabhaConfig
    | undefined;

  return {
    accountId: accountId ?? null,
    baseUrl: section?.baseUrl ?? "",
    botKey: section?.botKey ?? "",
    botId: extractBotId(section?.botKey ?? ""),
    webhookPort: section?.webhookPort ?? 8787,
    dmPolicy: section?.dmPolicy ?? "open",
    allowFrom: section?.allowFrom ?? [],
  };
}

function getClient(account: SabhaAccount): SabhaClient {
  return new SabhaClient(account.baseUrl, account.botKey);
}

export const sabhaPlugin = createChatChannelPlugin<SabhaAccount>({
  base: createChannelPluginBase({
    id: "sabha",
    setup: {
      resolveAccount,
      inspectAccount(cfg: any, accountId?: string | null) {
        const account = resolveAccount(cfg, accountId);
        return {
          enabled: Boolean(account.baseUrl && account.botKey),
          configured: Boolean(account.baseUrl && account.botKey),
          tokenStatus: account.botKey ? "available" : "missing",
        };
      },
    },
  }),

  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    threads: true,
    media: true,
    groupManagement: true,
    blockStreaming: true,
  },

  security: {
    dm: {
      channelKey: "sabha",
      resolvePolicy: (account: SabhaAccount) => account.dmPolicy,
      resolveAllowFrom: (account: SabhaAccount) => account.allowFrom,
      defaultPolicy: "open",
    },
  },

  threading: {
    topLevelReplyToMode: "thread",
  },

  messaging: {
    resolveSessionConversation(params: { rawId: string; threadId?: string }) {
      return resolveSessionConversation(params);
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000,

    attachedResults: {
      async sendText(ctx: any) {
        const account = resolveAccount(ctx.cfg);
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.threadId && ctx.replyToId) {
          const result = await client.replyInThread(
            roomId,
            Number(ctx.replyToId),
            ctx.text,
          );
          return { messageId: String(result.message.id) };
        }

        const messageId = await client.sendMessage(roomId, ctx.text);
        return { messageId: String(messageId) };
      },
    },

    base: {
      async sendMedia(ctx: any) {
        const account = resolveAccount(ctx.cfg);
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.mediaUrl) {
          const res = await globalThis.fetch(ctx.mediaUrl);
          const blob = await res.blob();
          const filename =
            ctx.mediaUrl.split("/").pop() ?? "attachment";
          await client.sendAttachment(roomId, blob, filename);
        }
      },
    },
  },

  actions: {
    describeMessageTool: () => ({
      actions: [
        "send",
        "edit",
        "unsend",
        "react",
        "reply",
        "thread-reply",
        "search",
      ],
      capabilities: [],
      schema: [],
    }),
  },
});
