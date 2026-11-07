// The full Sabha channel plugin: the setup plugin plus gateway, outbound,
// threading, messaging, actions, directory, prompt hints and status. Transport code loads lazily from channel.runtime.ts.
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { buildBaseChannelStatusSummary, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/channel-status";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { resolveSabhaAccount, type ResolvedSabhaAccount } from "../config/accounts.js";
import { SABHA_TEXT_CHUNK_LIMIT } from "../outbound/send.js";
import { getSabhaRuntime } from "../runtime.js";
import { sabhaSetupPlugin } from "./channel.setup.js";
import { sabhaMessageActions } from "../actions/adapter.js";
import { sabhaAgentPrompt } from "./agent-prompt.js";
import { SABHA_CHANNEL_ID } from "./meta.js";
import {
  buildSabhaThreadingToolContext,
  inferSabhaTargetChatType,
  looksLikeSabhaTargetId,
  normalizeSabhaTarget,
  resolveSabhaDeliveryTarget,
  resolveSabhaMessagingTarget,
  resolveSabhaOutboundSessionRoute,
} from "./messaging.js";

const loadRuntime = () => import("./channel.runtime.js");
const loadDirectory = () => import("../directory.js");

export const sabhaPlugin = createChatChannelPlugin<ResolvedSabhaAccount, unknown, unknown, 2>({
  base: {
    ...sabhaSetupPlugin,
    actions: sabhaMessageActions,
    agentPrompt: sabhaAgentPrompt,
    directory: createChannelDirectoryAdapter({
      listGroups: async (params) => (await loadDirectory()).listSabhaGroups(params),
      listGroupsLive: async (params) => (await loadDirectory()).listSabhaGroups(params),
      listPeers: async (params) => (await loadDirectory()).listSabhaPeers(params),
      listPeersLive: async (params) => (await loadDirectory()).listSabhaPeersLive(params),
      listGroupMembers: async (params) => (await loadDirectory()).listSabhaGroupMembers(params),
    }),
    resolver: {
      resolveTargets: async (params) => (await loadDirectory()).resolveSabhaTargets(params),
    },
    messaging: {
      targetPrefixes: ["sabha"],
      normalizeTarget: normalizeSabhaTarget,
      inferTargetChatType: ({ to }) => inferSabhaTargetChatType(to),
      resolveDeliveryTarget: resolveSabhaDeliveryTarget,
      resolveOutboundSessionRoute: resolveSabhaOutboundSessionRoute,
      targetResolver: {
        looksLikeId: looksLikeSabhaTargetId,
        hint: "<room id | channel:<id> | user:<id> | @{user id} | #room name | @person name>",
        resolveTarget: resolveSabhaMessagingTarget,
      },
    },
    status: {
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),
      buildAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.url,
        running: runtime?.running ?? false,
        connected: runtime?.connected,
        lifecycle: runtime?.lifecycle,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      }),
    },
    gateway: {
      apiVersion: 2,
      startAccount: async (ctx) => {
        const { account } = ctx;
        ctx.log?.info?.(`[sabha:${account.accountId}] starting`);
        const { monitorSabhaAccount } = await loadRuntime();
        await monitorSabhaAccount({
          account,
          cfg: ctx.cfg,
          runtime: getSabhaRuntime(),
          abortSignal: ctx.abortSignal,
          scheduler: ctx.scheduler,
          setStatus: ctx.setStatus,
          log: {
            info: (message) => ctx.log?.info?.(message),
            warn: (message) => ctx.log?.warn?.(message),
            error: (message) => ctx.log?.error?.(message),
          },
        });
      },
    },
  },
  threading: {
    resolveReplyToMode: ({ cfg, accountId }) => resolveSabhaAccount(cfg, accountId).replyToMode,
    buildToolContext: buildSabhaThreadingToolContext,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      textChunkLimit: SABHA_TEXT_CHUNK_LIMIT,
      chunkerMode: "markdown",
      chunker: (text, limit) => chunkMarkdownTextWithMode(text, limit, "length"),
    },
    attachedResults: {
      channel: SABHA_CHANNEL_ID,
      sendText: async (ctx) => (await loadRuntime()).sendText(ctx),
      sendMedia: async (ctx) => {
        if (!ctx.mediaUrl) return { outcome: "not_sent" as const, messageId: "" };
        return (await loadRuntime()).sendMedia({ ...ctx, mediaUrl: ctx.mediaUrl });
      },
    },
  },
});

// Sabha does not claim durable delivery; adapt the outbound contract as-is.
sabhaPlugin.message = createChannelMessageAdapterFromOutbound({ id: SABHA_CHANNEL_ID, outbound: sabhaPlugin.outbound! });
