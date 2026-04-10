import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import {
  createDefaultChannelRuntimeState,
  buildBaseChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { z } from "openclaw/plugin-sdk/zod";

import type { ResolvedBotAccount } from "./bot-accounts.js";
import {
  listBotAccountIds,
  resolveBotAccount,
  resolveBotAccountForSdk,
  resolveDefaultBotAccountId,
} from "./bot-accounts.js";
import { SabhaClient } from "./client.js";
import { getCachedSkillText } from "./skill-prompt.js";
import { sabhaSetupWizard } from "./setup-wizard.js";
import { monitorSabha } from "./monitor.js";
import { fetchGuardedAttachment } from "./ssrf-guard.js";

const SabhaBotAccountSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  botKey: z.string().optional(),
  botName: z.string().optional(),
  connectionMode: z.enum(["websocket", "webhook"]).optional(),
  websocketUrl: z.string().optional(),
  webhookPort: z.number().optional(),
  typingEnabled: z.boolean().optional(),
  dmPolicy: z.enum(["open", "allowlist"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  allowPrivateAttachmentHosts: z.boolean().optional(),
});

const SabhaConfigSchema = SabhaBotAccountSchema.extend({
  botAccounts: z.record(z.string(), SabhaBotAccountSchema.partial()).optional(),
  defaultBotAccount: z.string().optional(),
});

const sabhaConfigSchema = buildChannelConfigSchema(SabhaConfigSchema, {
  uiHints: {
    enabled: { label: "Enabled" },
    baseUrl: {
      label: "Server URL",
      placeholder: "https://sabha.co/1000006",
      help: "Sabha server URL (include workspace ID for multi-tenant)",
    },
    botKey: {
      label: "Bot key",
      placeholder: "42-AbCdEfGhIjKl",
      sensitive: true,
      help: "Bot key from registration via join code",
    },
    botName: {
      label: "Bot display name",
      placeholder: "OpenClaw",
      advanced: true,
      help: "Shown to users in typing indicators",
    },
    connectionMode: {
      label: "Connection mode",
      help: "WebSocket (recommended) or webhook",
    },
    typingEnabled: {
      label: "Typing indicators",
      advanced: true,
      help: "Show 'Bot is typing...' while processing (WebSocket mode only)",
    },
    websocketUrl: {
      label: "WebSocket URL",
      advanced: true,
      help: "Auto-detected from registration",
    },
    webhookPort: {
      label: "Webhook port",
      advanced: true,
      help: "Webhook mode only",
    },
    dmPolicy: { label: "DM policy" },
    allowFrom: {
      label: "Allow list",
      advanced: true,
      help: "User IDs for allowlist mode",
    },
    allowPrivateAttachmentHosts: {
      label: "Allow private attachment hosts",
      advanced: true,
      help: "Dangerous — disables SSRF protection on attachment downloads. Only enable in corporate / split-horizon DNS setups.",
    },
  },
});

/**
 * Back-compat shim: earlier code imported `resolveAccount` from this module.
 * New code should import `resolveBotAccount` directly from `./bot-accounts.js`
 * so the "bot account" naming stays consistent with the SDK boundary
 * translation.
 */
export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedBotAccount {
  return resolveBotAccount({ cfg, botAccountId: accountId });
}

function getClient(account: ResolvedBotAccount): SabhaClient {
  return new SabhaClient(account.baseUrl, account.botKey);
}

export const sabhaPlugin = createChatChannelPlugin<ResolvedBotAccount>({
  base: {
    id: "sabha",
    setupWizard: sabhaSetupWizard,
    meta: {
      id: "sabha",
      label: "Sabha",
      selectionLabel: "Sabha",
      docsPath: "/plugins/sabha",
      blurb: "Connect OpenClaw to a Sabha chat server.",
    },
    configSchema: sabhaConfigSchema,
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
      resolveAccount: resolveBotAccountForSdk,
      listAccountIds: listBotAccountIds,
      defaultAccountId: resolveDefaultBotAccountId,
      inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
        const account = resolveBotAccount({ cfg, botAccountId: accountId });
        return {
          enabled: Boolean(account.baseUrl && account.botKey),
          configured: Boolean(account.baseUrl && account.botKey),
          tokenStatus: account.botKey
            ? ("available" as const)
            : ("missing" as const),
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
        const account = resolveBotAccount({ cfg: params.cfg });
        const hints = [
          `This Sabha server is at ${account.baseUrl}. You can manage rooms, members, search messages, and react using the sabha_* tools.`,
        ];
        const skillText = getCachedSkillText(account.baseUrl);
        if (skillText) {
          hints.push(
            `Here is the full Sabha API reference:\n\n${skillText}`,
          );
        }
        return hints;
      },
    },
    status: {
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      buildChannelSummary: ({ snapshot }) =>
        buildBaseChannelStatusSummary(snapshot),
      buildAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        enabled: Boolean(account.baseUrl && account.botKey),
        configured: Boolean(account.baseUrl && account.botKey),
        running: runtime?.running ?? false,
        connected: runtime?.connected,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
      }),
    },
    gateway: {
      startAccount: async (ctx) => {
        const botAccount = ctx.account;
        const logPrefix = `[sabha:${botAccount.accountId}]`;

        const shouldMonitor =
          botAccount.connectionMode === "websocket" &&
          botAccount.baseUrl &&
          botAccount.botKey &&
          ctx.channelRuntime;

        if (shouldMonitor) {
          ctx.log?.info?.(`${logPrefix} Starting WebSocket monitor`);
          await monitorSabha({
            botAccount,
            config: ctx.cfg,
            runtime: ctx.channelRuntime!,
            abortSignal: ctx.abortSignal,
            logger: ctx.log,
            statusSink: (patch) => {
              ctx.setStatus({ ...ctx.getStatus(), ...patch });
            },
          });
        } else {
          ctx.log?.info?.(
            `${logPrefix} ${botAccount.connectionMode === "webhook" ? "Webhook mode" : "Not configured"} — waiting for shutdown`,
          );
          // Stay alive until gateway aborts so the account isn't restarted
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    },
  },

  security: {
    dm: {
      channelKey: "sabha",
      resolvePolicy: (account: ResolvedBotAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedBotAccount) => account.allowFrom,
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
        const account = resolveBotAccount({
          cfg: ctx.cfg,
          botAccountId: ctx.accountId,
        });
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
        const account = resolveBotAccount({
          cfg: ctx.cfg,
          botAccountId: ctx.accountId,
        });
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.mediaUrl) {
          const fetched = await fetchGuardedAttachment({
            url: ctx.mediaUrl,
            cfg: ctx.cfg,
          });
          const blob = new Blob(
            [new Uint8Array(fetched.buffer)],
            fetched.contentType ? { type: fetched.contentType } : {},
          );
          const filename =
            fetched.fileName ?? ctx.mediaUrl.split("/").pop() ?? "attachment";
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
