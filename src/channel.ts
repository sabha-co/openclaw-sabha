import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import {
  createDefaultChannelRuntimeState,
  buildBaseChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-core";
import { z } from "openclaw/plugin-sdk/zod";

import type { ResolvedBotAccount } from "./bot-accounts.js";
import {
  listBotAccountIds,
  resolveBotAccount,
  resolveBotAccountForSdk,
  resolveDefaultBotAccountId,
} from "./bot-accounts.js";
import { SabhaClient } from "./client.js";
import { chunkMarkdownText } from "./outbound/chunk.js";
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
  replyToMode: z.enum(["off", "first", "all"]).optional(),
});

const SabhaRoomConfigSchema = z.object({
  systemPrompt: z.string().optional(),
});

const SabhaConfigSchema = SabhaBotAccountSchema.extend({
  rooms: z.record(z.string(), SabhaRoomConfigSchema).optional(),
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
    replyToMode: {
      label: "Reply threading mode",
      help: '"off" = inline, "first" = thread on first reply, "all" = always thread',
    },
  },
});

function getClient(account: ResolvedBotAccount): SabhaClient {
  return new SabhaClient(account.baseUrl, account.botKey);
}

/**
 * Park a `gateway.startAccount` invocation until the framework aborts the
 * account. Used for accounts we deliberately don't service (disabled,
 * non-default webhook-mode, unconfigured) so the SDK doesn't keep
 * restarting them.
 */
function waitForAbort(abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
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
      inboundFormattingHints: () => ({
        text_markup: "markdown",
        rules: [
          "Write standard Markdown. Sabha converts it to rich text automatically.",
          "Headings, bold, italic, code blocks, and bullet lists all work.",
          "Pipe tables are not supported — use a code block or plain list instead.",
        ],
      }),
      reactionGuidance: () => ({
        level: "minimal" as const,
        channelLabel: "Sabha",
      }),
      messageToolHints: (params: { cfg: OpenClawConfig }) => {
        const account = resolveBotAccount({ cfg: params.cfg });
        const hints = [
          // Platform context — gives the agent a working mental model of
          // Sabha's structure even when the /skill endpoint is unreachable.
          // IMPORTANT: Kimi/GPT-style models default to Discord/Slack priors
          // when they see "thread" or "mention", so this hint explicitly
          // names the platform and tells the agent what NOT to assume.
          `YOU ARE ON SABHA — NOT Discord, Slack, Teams, or Telegram. Sabha is a team chat platform (server: ${account.baseUrl}). ` +
            `You are connected as the bot named "${account.botName}". ` +
            "Conversations happen in rooms (Open — anyone can join, or Closed — invite-only), " +
            "direct messages (1-on-1), and threads (which are nested replies within a room). " +
            "THREADS IN SABHA: A new thread is created automatically when you reply to someone's message with replyToId set — " +
            "the Sabha server creates the thread on the first reply. You do NOT have a tool to create a thread explicitly; " +
            "the channel plugin handles this based on config. If a user asks you to 'create a thread,' tell them " +
            "that threading happens automatically when you reply to their mention — it's configured by the operator, not by you. " +
            "Users have roles: administrator, moderator, member, or bot. " +
            "Messages support rich text (Markdown), file attachments, emoji reactions, and @mentions. " +
            "Use the sabha_* tools to manage rooms, members, search messages, and more. " +
            "Never suggest Discord/Slack/Teams instructions — those platforms don't apply here.",
          // Sabha mention syntax is deliberately NOT the same as Discord /
          // Slack. Without this reinforcement, agents default to `<@id>`
          // (Discord prior) or `@username` (Slack/plain text) and
          // server-side format_mentions silently drops the mention — no
          // pill, no notification, no mentionees[] entry. Sabha's
          // `format_mentions` regex is `/@\{(.+?)\}/`, so only the
          // curly-brace form triggers the rewrite. We surface the sender
          // id as `Name (@{id})` in the inbound envelope's `from` field
          // (see `src/inbound.ts`), and this hint tells the agent how to
          // use it.
          "MENTIONS IN SABHA: To mention a user, emit the literal token `@{USER_ID}` (curly braces, numeric id). " +
            "Do NOT use Discord-style `<@USER_ID>` or Slack-style `@username` — Sabha's server will NOT rewrite those, " +
            "and the user will see the raw text with no pill and no notification. The sender's id is shown in the " +
            "incoming message envelope's `from` field as `Name (@{id})` — copy the `@{id}` token verbatim to reply-mention " +
            "them. For example, if the envelope shows `From: Alice (@{42})`, reply with `Thanks @{42}, on it!` to produce " +
            "a real mention pill.",
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
        const isDefaultAccount = botAccount.accountId === DEFAULT_ACCOUNT_ID;

        // Skip disabled accounts entirely — the SDK still calls
        // startAccount for every listed account, not just enabled ones,
        // so we defend here to avoid opening a WebSocket as a disabled
        // bot identity.
        if (!botAccount.enabled) {
          ctx.log?.info?.(
            `${logPrefix} Disabled in config — waiting for shutdown`,
          );
          await waitForAbort(ctx.abortSignal);
          return;
        }

        // Webhook mode uses a single plugin-level HTTP route, which
        // cannot disambiguate events for more than one bot account.
        // Fail-closed for named accounts so a multi-bot config cannot
        // silently misroute events through the default bot's client
        // (wrong botId for mention detection, wrong credentials for
        // replies). Multi-bot webhook routing will require a path
        // prefix scheme — deferred to v1.1.
        if (botAccount.connectionMode === "webhook" && !isDefaultAccount) {
          ctx.log?.error?.(
            `${logPrefix} Webhook mode is only supported for the default bot account. ` +
              `Named accounts must use connectionMode: "websocket". Skipping this account.`,
          );
          await waitForAbort(ctx.abortSignal);
          return;
        }

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
          await waitForAbort(ctx.abortSignal);
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
    resolveReplyToMode: ({ cfg }) => {
      const section = (cfg.channels as Record<string, unknown>)?.sabha as
        | { replyToMode?: string }
        | undefined;
      return (section?.replyToMode as "off" | "first" | "all") ?? "first";
    },
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

        if (ctx.replyToId != null) {
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
            botAccount: account,
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
      chunkerMode: "markdown",
      chunker: chunkMarkdownText,
    },
  },
});
