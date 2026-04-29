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
  botName: z.string().optional(),
  websocketUrl: z.string().optional(),
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
    botName: {
      label: "Bot display name",
      placeholder: "OpenClaw",
      advanced: true,
      help: "Shown to users in typing indicators",
    },
    typingEnabled: {
      label: "Typing indicators",
      advanced: true,
      help: "Show 'Bot is typing...' while processing",
    },
    websocketUrl: {
      label: "WebSocket URL",
      advanced: true,
      help: "Auto-detected from registration",
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
 * account. Used for accounts we deliberately don't service (disabled or
 * unconfigured) so the SDK doesn't keep restarting them.
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
      blockStreaming: true,
    },
    // Setup-promotion contract for the SDK's
    // `moveSingleAccountChannelSectionToDefaultAccount` migration shim
    // (called from `index.ts:registerFull`). Without these arrays, the
    // shim only promotes keys in the SDK's static common set
    // (`dmPolicy`, `allowFrom`, etc.) — none of which include Sabha's
    // actual credentials. See `src/setup-contract.ts`.
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
      // Core's message-action runner gates the call on `actionHasTarget`
      // before dispatching to `handleAction`: only `to`, `channelId`, and
      // per-action aliases declared here are recognized as a valid target.
      // Without this entry, an agent calling `{ action: "read", roomId: 5 }`
      // would be rejected by core with "Action read requires a target." even
      // though the dispatch handler in `src/message-actions.ts` accepts the
      // alias. See `node_modules/openclaw/dist/message-action-runner-*.js`
      // (`actionRequiresTarget` / `actionHasTarget`).
      //
      // We publish only the genuine room-target aliases — `to` and
      // `channelId` are always accepted by core and `target` is the
      // runner's synthetic post-normalization field, so neither belongs
      // here. The pre-existing 6 actions (send/edit/unsend/react/
      // thread-reply) have the same dead-code aliasing in their dispatch
      // (`room_id`, `roomId`, `target` listed in `readNumber` calls) but
      // agents reach them via `to` in practice; broadening their alias
      // publishing is a separate PR's concern (see design doc).
      messageActionTargetAliases: {
        read: { aliases: ["roomId", "room_id", "channel_id"] },
        // `reactions` is id-only on the wire (server resolves the room
        // from the message id), so the target alias is `messageId` —
        // matching how core treats `edit` / `unsend` (both id-only).
        // Agents can call `message({ action: "reactions", messageId: 100 })`
        // without supplying a (now-ignored) roomId.
        reactions: { aliases: ["messageId", "message_id"] },
      },
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
          "read",
          "reactions",
        ],
        capabilities: [],
        schema: [
          // Used by `search` and `read` (both cursor-paginated read
          // shapes). These four fields are Sabha-specific and not in
          // core's `buildChannelTargetSchema`. The canonical scoping
          // fields (`channelId`/`channelIds`/`authorId`/`authorIds`) are
          // already exposed by core; the message-action handler reads
          // them via readNumberList and unions them with Sabha's
          // `roomId`/`roomIds` aliases.
          {
            properties: {
              before: Type.Optional(
                Type.String({
                  description:
                    "ISO timestamp upper bound (used by `search` and `read` to fetch older messages).",
                }),
              ),
              after: Type.Optional(
                Type.String({
                  description:
                    "ISO timestamp lower bound (used by `search` and `read`).",
                }),
              ),
              limit: Type.Optional(
                Type.Number({
                  description:
                    "Max results to return (used by `search` and `read`). Default 50, server hard cap 200.",
                }),
              ),
              cursor: Type.Optional(
                Type.String({
                  description:
                    "Opaque pagination cursor from a prior response's `nextCursor` (used by `search` and `read`). Pass to walk further; refining the query is usually preferable for `search`.",
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
      // `inboundFormattingHints` carries the fuller Sabha identity +
      // mention-syntax stub on the inbound auto-reply path. It renders
      // via `buildInboundMetaSystemPrompt` regardless of tool profile,
      // so it survives `coding`-profile gateways where `messageToolHints`
      // would be gated out. It does NOT render for proactive (non-inbound)
      // agent runs — those are covered by the parallel reminder in
      // `messageToolHints` below. Both hooks are needed; they cover
      // different render paths. Fast-reply mode skips this hook entirely
      // — accepted residual gap. See
      // docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md.
      inboundFormattingHints: () => ({
        text_markup: "markdown",
        rules: [
          // Identity. Defends against Kimi/GPT priors that default to
          // Discord/Slack when they see "thread" or "mention".
          "You are on Sabha — a team chat platform. NOT Discord, Slack, Teams, or Telegram.",
          // Mention syntax. Sabha's server-side `format_mentions` regex
          // is `/@\{(.+?)\}/`, so only the curly-brace form triggers the
          // rewrite. Discord-style `<@id>` and Slack-style `@username`
          // are silently dropped — no pill, no notification, no
          // mentionees[] entry. The sender's id is shown in the inbound
          // envelope's `from` field as `Name (@{id})`; copy verbatim.
          "To mention a user, emit `@{USER_ID}` (curly braces). Discord-style `<@id>` and Slack-style `@username` are silently dropped.",
          "Write standard Markdown. Sabha converts it to rich text automatically.",
          "Headings, bold, italic, code blocks, and bullet lists all work.",
          "Pipe tables are not supported — use a code block or plain list instead.",
        ],
      }),
      reactionGuidance: () => ({
        level: "minimal" as const,
        channelLabel: "Sabha",
      }),
      // `messageToolHints` is rendered by `buildMessagingSection` on
      // every agent system prompt where the `message` tool is in scope —
      // including proactive (non-inbound) agent runs that
      // `inboundFormattingHints` does not reach. So identity + mention
      // syntax need a minimal copy here too, not just in
      // `inboundFormattingHints` (which only renders on the inbound
      // auto-reply path via `buildInboundMetaSystemPrompt`). The two
      // hooks cover different render paths, not the same one twice.
      // See docs/MESSAGE-TOOL-HINT-DEPENDENCE-PLAN.md.
      messageToolHints: () => {
        return [
          // Identity + mention reminder. Kept short — the longer
          // version lives in `inboundFormattingHints` for the inbound
          // path. This single line covers proactive agent runs (e.g.
          // an agent on `messaging` profile invoked by the user to
          // send a Sabha message) where the inbound hooks don't fire.
          "SABHA MENTIONS: You're on Sabha (not Discord/Slack/Teams). " +
            "Mention users with `@{USER_ID}` (curly braces, numeric id) — Discord-style `<@id>` " +
            "and Slack-style `@username` are silently dropped by Sabha's server.",
          // Search returns at most 200 hits regardless of caller. The
          // explicit `hasMore` signal closes the silent-truncation gap —
          // without it the agent would summarize the visible slice as if
          // it were complete.
          "SEARCH IN SABHA: The `search` action returns up to 200 results (default 50). It returns `hasMore: true` " +
            "when more matches exist beyond what was returned — refine the query or pass `channelId` / `channelIds` " +
            "(or Sabha's `roomIds` alias) and `authorId` / `authorIds` to scope, or pass `cursor` (from `nextCursor`) " +
            "to walk further. Time-bound with `before` / `after` (ISO timestamps).",
          // `read` returns newest-first. Without this hint, agents
          // summarizing a thread emit the messages in wire order and
          // produce a reverse-chronological narrative.
          "READING HISTORY: The `message` tool's `read` action returns messages newest-first. " +
            "Reorder client-side before summarizing if you want chronological output. " +
            "Pass `cursor` (from a prior page's `nextCursor`) to walk further back in time.",
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

        const shouldMonitor =
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
            `${logPrefix} Not configured — waiting for shutdown`,
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

        const sent = await client.sendMessage(
          roomId,
          ctx.text,
          ctx.replyToId != null
            ? { parentMessageId: Number(ctx.replyToId) }
            : undefined,
        );
        return { messageId: sent != null ? String(sent.id) : "" };
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
          const sent = await client.sendAttachment(roomId, blob, filename);
          return { messageId: sent != null ? String(sent.id) : "" };
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
