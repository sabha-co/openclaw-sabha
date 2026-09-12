import {
  createChatChannelPlugin,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";

type PluginRuntimeChannel = PluginRuntime["channel"];
import {
  createDefaultChannelRuntimeState,
  buildBaseChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { Type } from "typebox";

import type { ResolvedSabhaAccount } from "./accounts.js";
import {
  resolveSabhaAccount,
} from "./accounts.js";
import { SabhaClient } from "./client.js";
import {
  listSabhaDirectoryGroups,
  listSabhaDirectoryPeers,
  listSabhaDirectoryPeersLive,
} from "./directory.js";
import { sabhaMessageActions } from "./message-actions.js";
import {
  buildSabhaThreadingToolContext,
  inferSabhaTargetChatType,
  looksLikeSabhaTargetId,
  normalizeSabhaMessagingTarget,
  resolveSabhaDeliveryTarget,
  resolveSabhaMessagingTarget,
} from "./messaging.js";
import { chunkMarkdownText } from "./outbound/chunk.js";
import { resolveSabhaTargets } from "./resolver.js";
import { buildSabhaSessionRoute } from "./session.js";
import { sabhaSetupPlugin } from "./channel-setup.js";
import { monitorSabha } from "./monitor.js";
import { sendSabhaAttachment } from "./delivery.js";


function getClient(account: ResolvedSabhaAccount): SabhaClient {
  if (!account.enabled || !account.apiBaseUrl || !account.botKey) throw new Error(`Sabha account "${account.accountId}" is disabled or unconfigured`);
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
    ...sabhaSetupPlugin,
    // Channel-owned action surface for the shared `message` tool.
    // Discovery half (which actions Sabha supports) lives here; dispatch
    // half (executing each action against `SabhaClient`) lives in
    // `src/message-actions.ts`. Together they let the agent target Sabha
    // messages by id (edit, react, delete, search) instead of only
    // sending replies through the inbound pipeline.
    actions: {
      ...sabhaMessageActions,
      // No `messageActionTargetAliases` here — and no prompt nudge
      // about passing `to`/`target` either. Both were tried; both
      // failed:
      //
      // 1. Aliases (commit 6b35e75): the SDK reads them via
      //    `getBootstrapChannelPlugin`, which only resolves *bundled*
      //    extensions inside the openclaw npm package. Sabha is
      //    externally installed at `~/.openclaw/extensions/sabha/` and
      //    never lands in that registry, so declarations here are
      //    silently dropped by the gate.
      //
      // 2. Prompt nudge ("pass `to: <roomId>` and `messageId`"): the
      //    agent doesn't have the numeric room id in its envelope —
      //    only the room name surfaces ("General"). It fills `to`
      //    with that name, the directory resolver fails with "Unknown
      //    target", and the user sees the agent confabulating
      //    "reactions aren't supported on Sabha".
      //
      // What works: the runner already auto-fills `target` from
      // `toolContext.currentChannelId` when the agent passes neither
      // `target` nor `to`/`channelId` (see
      // `message-action-runner-BN7W0fv6.js:106-114`). For Sabha
      // inbounds, `currentChannelId` is the numeric room id (set via
      // `inbound.ts:202` → `agent-runner-utils:63`). So the natural
      // agent call `{action:"react", messageId, emoji}` succeeds —
      // the runner injects the room id, gate passes, dispatch reads
      // `messageId`. The auto-fill condition is gated on the agent
      // passing nothing for the target slot, which is why a prompt
      // nudge to "also pass `to`" actually breaks it (it disables
      // auto-fill, then the agent's guessed name fails resolution).
      //
      // Proactive (non-inbound) react/reactions calls don't have
      // `currentChannelId` set and will fail the gate. Acceptable
      // niche — agents can fetch the room id via `read`/`search`
      // first or be coached per-call by the operator.
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
    // Plugin-owned target helpers consulted by the SDK's message-action
    // runner. Required so bare-numeric Sabha room ids (e.g. `21`) survive
    // the runner's `looksLikeTargetId` gate, which otherwise rejects any
    // numeric shorter than 6 digits and falls through to a directory
    // lookup that matches by name. See `src/messaging.ts` for the full
    // failure-mode trace.
    messaging: {
      normalizeTarget: normalizeSabhaMessagingTarget,
      // Inferred from canonical prefix (`user:` → direct, `channel:` →
      // group). Bare-numeric inputs return undefined since Sabha rooms
      // and users share a numeric id namespace; the SDK's own
      // raw-prefix heuristics cover the fall-through. See
      // `inferSabhaTargetChatType` in `src/messaging.ts`.
      inferTargetChatType: ({ to }) => inferSabhaTargetChatType(to),
      // For thread sessions, deliver to the parent room with the thread
      // room as `threadId` — matches Mattermost/Slack/Telegram/Feishu
      // pattern. Non-thread sessions deliver to the conversation
      // directly. See `resolveSabhaDeliveryTarget` in `src/messaging.ts`.
      resolveDeliveryTarget: ({ conversationId, parentConversationId }) =>
        resolveSabhaDeliveryTarget({ conversationId, parentConversationId }),
      resolveOutboundSessionRoute: (params) => {
        const account = resolveSabhaAccount({ cfg: params.cfg, accountId: params.accountId });
        const roomId = (params.resolvedTarget?.to ?? params.target).replace(/^(?:sabha:)?(?:channel:|group:|user:)?/, "");
        if (!/^\d+$/.test(roomId)) return null;
        const direct = buildSabhaSessionRoute({ ...params, accountId: account.accountId, roomId, chatType: "direct", threadId: undefined });
        return params.currentSessionKey === direct.sessionKey || params.resolvedTarget?.kind === "user"
          ? direct
          : buildSabhaSessionRoute({ ...params, accountId: account.accountId, roomId, chatType: "group", threadId: params.threadId == null ? undefined : String(params.threadId) });
      },
      targetResolver: {
        looksLikeId: looksLikeSabhaTargetId,
        hint: "<roomId | userId | @{userId}>",
        resolveTarget: async ({
          cfg,
          accountId,
          input,
          normalized,
          preferredKind,
        }) =>
          await resolveSabhaMessagingTarget({
            cfg,
            accountId,
            input,
            normalized,
            preferredKind,
          }),
      },
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
        enabled: account.enabled,
        configured: Boolean(account.baseUrl && account.apiBaseUrl && account.botKey),
        running: runtime?.running ?? false,
        connected: runtime?.connected,
        lifecycle: runtime?.lifecycle,
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
        ctx.setStatus({ ...ctx.getStatus(), lifecycle: "starting" });

        // Skip disabled accounts entirely — the SDK still calls
        // startAccount for every listed account, not just enabled ones,
        // so we defend here to avoid opening a WebSocket as a disabled
        // bot identity.
        if (!account.enabled) {
          ctx.log?.info?.(
            `${logPrefix} Disabled in config — waiting for shutdown`,
          );
          ctx.setStatus({ ...ctx.getStatus(), lifecycle: "blocked", connected: false });
          await waitForAbort(ctx.abortSignal);
          ctx.setStatus({ ...ctx.getStatus(), lifecycle: "stopped" });
          return;
        }

        const shouldMonitor =
          account.baseUrl &&
          account.apiBaseUrl &&
          account.botKey &&
          ctx.channelRuntime;

        if (shouldMonitor) {
          ctx.log?.info?.(`${logPrefix} Starting WebSocket monitor`);
          // The SDK types `ctx.channelRuntime` as the minimal
          // `ChannelRuntimeSurface` (`runtimeContexts` + index signature),
          // but the runtime *value* — when present — is documented to be
          // the full `createPluginRuntime().channel` surface. Sabha's
          // monitor/inbound code uses the rich shape (`channel.media`,
          // `channel.routing`, `channel.reply`, ...), so cast at the
          // boundary. See SDK ChannelGatewayContext docs and Discord's
          // `monitorDiscordProvider` for the same pattern.
          await monitorSabha({
            account,
            config: ctx.cfg,
            runtime: ctx.channelRuntime as unknown as PluginRuntimeChannel,
            abortSignal: ctx.abortSignal,
            logger: ctx.log,
            statusSink: (patch) => {
              ctx.setStatus({ ...ctx.getStatus(), ...patch });
            },
          });
        } else {
          ctx.log?.info?.(
            `${logPrefix} ${ctx.channelRuntime ? "Not configured" : "Missing host channel runtime"} — waiting for shutdown`,
          );
          ctx.setStatus({ ...ctx.getStatus(), lifecycle: "blocked", connected: false });
          await waitForAbort(ctx.abortSignal);
          ctx.setStatus({ ...ctx.getStatus(), lifecycle: "stopped" });
        }
      },
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
    // Surface `replyToMode` (and currentChannelId / currentMessageId /
    // currentThreadTs / hasRepliedRef) on the SDK's tool context so the
    // `message.send` auto-inject path threads the agent's first reply
    // for top-level group inbounds. Without this hook, the SDK's
    // fall-through context omits `replyToMode`, which makes
    // `resolveAndApplyOutboundReplyToId` (message-action-runner-*.js)
    // short-circuit at `mode === "off"` and the agent's reply lands
    // in the parent room instead of the thread. Forces "off" for
    // in-thread inbounds (Sabha's thread room IS the room — auto-inject
    // would create a nested thread) and DMs (no threads).
    // See `buildSabhaThreadingToolContext` for the full rationale.
    buildToolContext: (params) => buildSabhaThreadingToolContext(params),
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
        if (!sent) throw new Error("Sabha send returned no message receipt");
        return { messageId: String(sent.id), roomId: String(sent.roomId) };
      },
      async sendMedia(ctx) {
        const account = resolveSabhaAccount({
          cfg: ctx.cfg,
          accountId: ctx.accountId,
        });
        const client = getClient(account);
        const roomId = Number(ctx.to);

        if (ctx.mediaUrl) {
          const sent = await sendSabhaAttachment({ client, account, roomId, url: ctx.mediaUrl,
            ...(ctx.replyToId == null ? {} : { parentMessageId: Number(ctx.replyToId) }),
          });
          return { messageId: String(sent.id), roomId: String(sent.roomId) };
        }

        return { outcome: "not_sent" as const, messageId: "" };
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

// Adapt the public outbound contract; Sabha does not claim durable delivery.
sabhaPlugin.message = createChannelMessageAdapterFromOutbound({ id: "sabha", outbound: sabhaPlugin.outbound! });
