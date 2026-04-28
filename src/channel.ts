import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import {
  createDefaultChannelRuntimeState,
  buildBaseChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-core";
import { z } from "openclaw/plugin-sdk/zod";
import { Type } from "@sinclair/typebox";

import type { ResolvedSabhaAccount } from "./accounts.js";
import {
  listSabhaAccountIds,
  resolveSabhaAccount,
  resolveSabhaAccountForSdk,
  resolveDefaultSabhaAccountId,
} from "./accounts.js";
import { inspectSabhaAccount } from "./account-inspect.js";
import { SabhaClient } from "./client.js";
import {
  listSabhaDirectoryGroups,
  listSabhaDirectoryPeers,
  listSabhaDirectoryPeersLive,
} from "./directory.js";
import { sabhaMessageActions } from "./message-actions.js";
import { chunkMarkdownText } from "./outbound/chunk.js";
import { resolveSabhaTargets } from "./resolver.js";
import { sabhaSetupWizard } from "./setup-wizard.js";
import {
  sabhaNamedAccountPromotionKeys,
  sabhaSetupAdapter,
  sabhaSingleAccountKeysToMove,
} from "./setup-contract.js";
import { monitorSabha } from "./monitor.js";
import { fetchGuardedAttachment } from "./ssrf-guard.js";

const SabhaAccountSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  botKey: z.string().optional(),
  webhookSecret: z.string().optional(),
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

const SabhaConfigSchema = SabhaAccountSchema.extend({
  rooms: z.record(z.string(), SabhaRoomConfigSchema).optional(),
  accounts: z.record(z.string(), SabhaAccountSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
});

const sabhaConfigSchema = buildChannelConfigSchema(SabhaConfigSchema, {
  uiHints: {
    enabled: { label: "Enabled" },
    baseUrl: {
      label: "Server URL",
      placeholder: "https://sabha.co/1000006",
      help: "Sabha server URL (include workspace ID for multi-tenant)",
    },
    apiBaseUrl: {
      label: "Bot API base URL",
      placeholder: "https://sabha.co/1000006/api/bots",
      advanced: true,
      help: "Auto-detected from registration; endpoint for bearer-auth HTTP calls",
    },
    botKey: {
      label: "Bot key",
      placeholder: "42-AbCdEfGhIjKl",
      sensitive: true,
      help: "Bot key from registration via join code",
    },
    webhookSecret: {
      label: "Webhook secret",
      placeholder: "whsec_…",
      sensitive: true,
      advanced: true,
      help: "Captured at registration. Reserved for webhook HMAC verification in a future release — not yet used.",
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

function getClient(account: ResolvedSabhaAccount): SabhaClient {
  return new SabhaClient(account.apiBaseUrl, account.botKey);
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

export const sabhaPlugin = createChatChannelPlugin<ResolvedSabhaAccount>({
  base: {
    id: "sabha",
    setupWizard: sabhaSetupWizard,
    meta: {
      id: "sabha",
      label: "Sabha",
      selectionLabel: "Sabha (Bot API)",
      detailLabel: "Sabha Bot",
      docsPath: "/channels/sabha",
      docsLabel: "sabha",
      systemImage: "bubble.left.and.bubble.right",
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
    // Setup-promotion contract for the SDK's
    // `moveSingleAccountChannelSectionToDefaultAccount` migration shim
    // (called from `index.ts:registerFull`). Without these arrays, the
    // shim only promotes keys in the SDK's static common set
    // (`webhookSecret`, `dmPolicy`, `allowFrom`) — none of which include
    // Sabha's actual credentials. See `src/setup-contract.ts`.
    setup: {
      ...sabhaSetupAdapter,
      singleAccountKeysToMove: sabhaSingleAccountKeysToMove,
      namedAccountPromotionKeys: sabhaNamedAccountPromotionKeys,
    },
    config: {
      resolveAccount: resolveSabhaAccountForSdk,
      listAccountIds: listSabhaAccountIds,
      defaultAccountId: resolveDefaultSabhaAccountId,
      // Per-account read-only snapshot for the OpenClaw doctor / audit-channel
      // layer. Returns the tri-state credential status and full merged config
      // shape that peers (Slack/Discord/Telegram) ship — see `src/account-inspect.ts`
      // for the Sabha-tailored shape and the rationale for the omitted bits
      // (no env-var path, no tokenFile indirection).
      inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        inspectSabhaAccount({ cfg, accountId }),
    },
    // Channel-owned action surface for the shared `message` tool.
    // Discovery half (which actions Sabha supports) lives here; dispatch
    // half (executing each action against `SabhaClient`) lives in
    // `src/message-actions.ts`. Together they let the agent target Sabha
    // messages by id (edit, react, delete, search) instead of only
    // sending replies through the inbound pipeline.
    actions: {
      ...sabhaMessageActions,
      describeMessageTool: () => ({
        // `reply` deliberately omitted: `send` with `replyToId` covers the
        // implicit-target reply, and `thread-reply` covers the explicit one
        // (fails closed when `messageId` is missing). See SUPPORTED_ACTIONS
        // in src/message-actions.ts.
        actions: [
          "send",
          "edit",
          "unsend",
          "react",
          "thread-reply",
          "search",
          "member-info",
        ],
        capabilities: [],
        schema: [
          // search action — these fields are Sabha-specific and not in
          // core's `buildChannelTargetSchema`. The canonical scoping
          // fields (`channelId`/`channelIds`/`authorId`/`authorIds`) are
          // already exposed by core; the message-action handler reads
          // them via readNumberList and unions them with Sabha's
          // `roomId`/`roomIds` aliases. So we only need to advertise
          // the genuinely-new fields here.
          {
            properties: {
              before: Type.Optional(
                Type.String({
                  description:
                    "Sabha search: ISO timestamp upper bound (older messages).",
                }),
              ),
              after: Type.Optional(
                Type.String({
                  description: "Sabha search: ISO timestamp lower bound.",
                }),
              ),
              limit: Type.Optional(
                Type.Number({
                  description:
                    "Sabha search: max results to return. Default 50, server hard cap 200.",
                }),
              ),
              cursor: Type.Optional(
                Type.String({
                  description:
                    "Sabha search: opaque pagination cursor from a prior response's `nextCursor`. Pass to walk further; refining the query is usually preferable.",
                }),
              ),
            },
            visibility: "current-channel" as const,
          },
        ],
      }),
    },
    // Sabha rooms surface as directory groups; per-room members and
    // bot-reachable users surface as directory entries. `listPeers` hits
    // `/api/bots/users` (server-scoped to users sharing rooms with the
    // bot); `listPeersLive` hits `/autocompletable/users` for the
    // autocomplete fast path.
    directory: createChannelDirectoryAdapter({
      listGroups: async (params) =>
        await listSabhaDirectoryGroups({
          cfg: params.cfg,
          accountId: params.accountId,
          query: params.query,
          limit: params.limit,
        }),
      listPeers: async (params) =>
        await listSabhaDirectoryPeers({
          cfg: params.cfg,
          accountId: params.accountId,
          query: params.query,
          limit: params.limit,
        }),
      listPeersLive: async (params) =>
        await listSabhaDirectoryPeersLive({
          cfg: params.cfg,
          accountId: params.accountId,
          query: params.query,
          limit: params.limit,
        }),
    }),
    // Name → id resolution for free-form mention targets and group refs.
    // Discord/Slack/Telegram all wire this slot. Sabha needs it because its
    // inbound only pre-resolves `@{user_id}` curly-brace mentions; anything
    // else arrives as plain text. See `src/resolver.ts`.
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) =>
        await resolveSabhaTargets({ cfg, accountId, inputs, kind }),
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
        const account = resolveSabhaAccount({ cfg: params.cfg });
        return [
          // Platform context — gives the agent a working mental model of
          // Sabha's structure. IMPORTANT: Kimi/GPT-style models default to
          // Discord/Slack priors when they see "thread" or "mention", so
          // this hint explicitly names the platform and tells the agent
          // what NOT to assume.
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
          // Search returns at most 200 hits regardless of caller. The
          // explicit `hasMore` signal closes the silent-truncation gap —
          // without it the agent would summarize the visible slice as if
          // it were complete.
          "SEARCH IN SABHA: The `search` action returns up to 200 results (default 50). It returns `hasMore: true` " +
            "when more matches exist beyond what was returned — refine the query or pass `channelId` / `channelIds` " +
            "(or Sabha's `roomIds` alias) and `authorId` / `authorIds` to scope, or pass `cursor` (from `nextCursor`) " +
            "to walk further. Time-bound with `before` / `after` (ISO timestamps).",
        ];
      },
    },
    status: {
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      buildChannelSummary: ({ snapshot }) =>
        buildBaseChannelStatusSummary(snapshot),
      buildAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        enabled: Boolean(account.baseUrl && account.apiBaseUrl && account.botKey),
        configured: Boolean(account.baseUrl && account.apiBaseUrl && account.botKey),
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
        const account = ctx.account;
        const logPrefix = `[sabha:${account.accountId}]`;
        const isDefaultAccount = account.accountId === DEFAULT_ACCOUNT_ID;

        // Skip disabled accounts entirely — the SDK still calls
        // startAccount for every listed account, not just enabled ones,
        // so we defend here to avoid opening a WebSocket as a disabled
        // bot identity.
        if (!account.enabled) {
          ctx.log?.info?.(
            `${logPrefix} Disabled in config — waiting for shutdown`,
          );
          await waitForAbort(ctx.abortSignal);
          return;
        }

        // Webhook mode uses a single plugin-level HTTP route, which
        // cannot disambiguate events for more than one bot account.
        // Fail-closed for named accounts so a multi-account config cannot
        // silently misroute events through the default bot's client
        // (wrong botId for mention detection, wrong credentials for
        // replies). Multi-account webhook routing will require a path
        // prefix scheme — deferred to v1.1.
        if (account.connectionMode === "webhook" && !isDefaultAccount) {
          ctx.log?.error?.(
            `${logPrefix} Webhook mode is only supported for the default bot account. ` +
              `Named accounts must use connectionMode: "websocket". Skipping this account.`,
          );
          await waitForAbort(ctx.abortSignal);
          return;
        }

        const shouldMonitor =
          account.connectionMode === "websocket" &&
          account.baseUrl &&
          account.apiBaseUrl &&
          account.botKey &&
          ctx.channelRuntime;

        if (shouldMonitor) {
          ctx.log?.info?.(`${logPrefix} Starting WebSocket monitor`);
          await monitorSabha({
            account,
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
            `${logPrefix} ${account.connectionMode === "webhook" ? "Webhook mode" : "Not configured"} — waiting for shutdown`,
          );
          await waitForAbort(ctx.abortSignal);
        }
      },
    },
  },

  security: {
    dm: {
      channelKey: "sabha",
      resolvePolicy: (account: ResolvedSabhaAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedSabhaAccount) => account.allowFrom,
      defaultPolicy: "open",
    },
  },

  threading: {
    // Per-account read so the SDK's reply planner sees the same value
    // as the plugin's deliver callback (monitor.ts / index.ts both
    // resolve `account.replyToMode` for the same decision). Reading the
    // base block alone would silently ignore per-account overrides.
    resolveReplyToMode: ({ cfg, accountId }) => {
      const account = resolveSabhaAccount({ cfg, accountId });
      return account.replyToMode;
    },
  },

  outbound: {
    attachedResults: {
      channel: "sabha",
      async sendText(ctx) {
        const account = resolveSabhaAccount({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
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
        const account = resolveSabhaAccount({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
        });
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.mediaUrl) {
          const fetched = await fetchGuardedAttachment({
            url: ctx.mediaUrl,
            account,
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
