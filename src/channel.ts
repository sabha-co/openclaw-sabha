import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";

import type { SabhaAccount, SabhaConfig } from "./types.js";
import { SabhaClient, extractBotId } from "./client.js";
import { getCachedSkillText } from "./skill-prompt.js";

const accountHelpers = createAccountListHelpers("sabha");

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): SabhaAccount {
  const section = (cfg.channels as Record<string, unknown>)?.sabha as
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
  base: {
    id: "sabha",
    meta: {
      id: "sabha",
      label: "Sabha",
      selectionLabel: "Sabha",
      docsPath: "/plugins/sabha",
      blurb: "Connect OpenClaw to a Sabha chat server.",
    },
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
    config: {
      resolveAccount,
      listAccountIds: accountHelpers.listAccountIds,
      inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
        const account = resolveAccount(cfg, accountId);
        return {
          enabled: Boolean(account.baseUrl && account.botKey),
          configured: Boolean(account.baseUrl && account.botKey),
          tokenStatus: account.botKey ? ("available" as const) : ("missing" as const),
        };
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
    agentPrompt: {
      messageToolHints: (params: { cfg: OpenClawConfig }) => {
        const account = resolveAccount(params.cfg);
        const hints = [
          `This Sabha server is at ${account.baseUrl}. You can manage rooms, members, search messages, and react using the sabha_* tools.`,
        ];
        const skillText = getCachedSkillText();
        if (skillText) {
          hints.push(
            `Here is the full Sabha API reference:\n\n${skillText}`,
          );
        }
        return hints;
      },
    },
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

  outbound: {
    attachedResults: {
      channel: "sabha",
      async sendText(ctx) {
        const account = resolveAccount(ctx.cfg);
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.threadId != null && ctx.replyToId != null) {
          const result = await client.replyInThread(
            roomId,
            Number(ctx.replyToId),
            ctx.text,
          );
          return { messageId: String(result.message.id) };
        }

        const messageId = await client.sendMessage(roomId, ctx.text);
        return { messageId: messageId != null ? String(messageId) : "" };
      },
      async sendMedia(ctx) {
        const account = resolveAccount(ctx.cfg);
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.mediaUrl) {
          const res = await globalThis.fetch(ctx.mediaUrl);
          const blob = await res.blob();
          const filename = ctx.mediaUrl.split("/").pop() ?? "attachment";
          const messageId = await client.sendAttachment(roomId, blob, filename);
          return { messageId: messageId != null ? String(messageId) : "" };
        }

        return { messageId: "" };
      },
    },
    base: {
      deliveryMode: "direct",
      textChunkLimit: 10000,
    },
  },
});
