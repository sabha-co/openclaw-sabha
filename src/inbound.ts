import type {
  ResolvedSabhaAccount,
  SabhaMessageCreatedPayload,
  SabhaMessageEventPayload,
  SabhaMessageUpdatedPayload,
  SabhaMessageDeletedPayload,
  SabhaBoostCreatedPayload,
  SabhaBoostDeletedPayload,
  SabhaUserCreatedPayload,
  SabhaUserDeletedPayload,
} from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { wasBotMentioned, resolveChatType } from "./webhook.js";
import { resolveSessionFromPayload, buildSabhaSessionRoute } from "./session.js";
import { resolveAttachmentSsrfPolicy } from "./ssrf-guard.js";

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createChannelIngressResolver, defineStableChannelIngressIdentity } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { readAgentRunTerminalOutcome } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelInboundTurnPlan, BuildChannelInboundEventContextParams } from "openclaw/plugin-sdk/channel-inbound";
import { formatStreamError } from "./draft-stream.js";

type ChannelRuntime = PluginRuntime["channel"];

type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  error?: (message: string) => void;
};

const CHANNEL_ID = "sabha";

/**
 * Pre-flight check: should the bot act on this inbound message at all?
 *
 * Mirrors the gating logic at the top of `processInboundMessage` so
 * callers (like the WebSocket monitor) can decide whether to start a
 * typing indicator without duplicating the rules. Applies uniformly to
 * every message-bearing variant: the bot's own events are always
 * filtered out, and in groups we require an @mention regardless of
 * whether the event is a create, edit, delete, or boost.
 */
export function shouldHandleInbound(
  payload: SabhaMessageEventPayload,
  botId: number,
): boolean {
  // Skip the bot's own events (self-echo filter). This covers both
  // `message_created` replies and any `message_updated` / `*_deleted`
  // echoes Sabha sends back when the bot edits / deletes its own content
  // through the by-bots controllers (Scout A, hazard #2).
  if (payload.user.id === botId) return false;
  // In DMs and threads, always handle — no mention required. Threads
  // the bot created are ongoing conversations; requiring a re-mention
  // on every reply would break the auto-thread flow.
  const isDm = resolveChatType(payload.room.type) === "direct";
  const isThread = payload.message.thread != null;
  if (isDm || isThread) return true;
  // In top-level group messages, require an @mention.
  if (!wasBotMentioned(payload, botId)) return false;
  return true;
}

type InboundDeps = {
  runtime: PluginRuntime | ChannelRuntime;
  cfg: OpenClawConfig;
  account: ResolvedSabhaAccount;
  deliver: NonNullable<ChannelInboundTurnPlan["delivery"]>["deliver"];
  onAdmitted?: () => void;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /** Full accumulated assistant text, never a token delta. */
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;
};

/** Adapt Sabha facts into the injected host's inbound kernel. */
export async function processInboundMessage(
  payload: SabhaMessageCreatedPayload,
  deps: InboundDeps,
): Promise<void> {
  const { cfg, account, deliver, logger, onPartialReply, onAdmitted, abortSignal } = deps;
  const channel = "channel" in deps.runtime ? deps.runtime.channel : deps.runtime;
  if (!account.enabled || abortSignal?.aborted || !shouldHandleInbound(payload, account.botId)) return;
  const chatType = resolveChatType(payload.room.type);
  const isDm = chatType === "direct";
  const session = resolveSessionFromPayload(payload);
  const accountId = account.accountId;
  const roomId = String(payload.room.id);
  const messageId = String(payload.message.id);
  const rawBody = payload.message.body.plain;
  const timestamp = new Date(payload.message.created_at).getTime();
  const mentioned = wasBotMentioned(payload, account.botId);
  const agentRoute = channel.routing.resolveAgentRoute({
    cfg, channel: CHANNEL_ID, accountId,
    peer: { kind: chatType, id: session.conversationId },
  });
  const sessionRoute = buildSabhaSessionRoute({ cfg, agentId: agentRoute.agentId, accountId, roomId, chatType, threadId: session.threadId });
  const route = { ...agentRoute, sessionKey: sessionRoute.sessionKey, lastRoutePolicy: "session" as const };
  const ingress = await createChannelIngressResolver({
    channelId: CHANNEL_ID, accountId, cfg,
    identity: defineStableChannelIngressIdentity({
      key: "sabha-user-id", kind: "stable-id", authentication: "asserted",
      normalize: (value) => /^\d+$/.test(value.trim()) ? value.trim() : null,
      resolveParticipant: (subject) => ({ domain: account.baseUrl, idKind: "sabha-user-id", id: String(subject.stableId) }),
    }),
  }).message({
    subject: { stableId: String(payload.user.id) },
    conversation: { kind: chatType, id: roomId },
    contextBinding: { agentId: route.agentId, sessionKey: route.sessionKey, messageId, inboundEventKind: "user_request" },
    dmPolicy: account.dmPolicy, groupPolicy: "open", allowFrom: account.dmPolicy === "open" ? ["*"] : account.allowFrom,
    mentionFacts: { canDetectMention: true, wasMentioned: mentioned, hasAnyMention: mentioned },
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      activation: { requireMention: !isDm && !session.threadId, allowTextCommands: true },
    },
    command: { commandOwnerAllowFrom: account.allowFrom, groupOwnerAllowFrom: "none", allowTextCommands: true, hasControlCommand: channel.commands.isControlCommandMessage(rawBody, cfg) },
  });
  if (ingress.ingress.admission !== "dispatch" || abortSignal?.aborted) return;

  const result = await channel.inbound.run({
    channel: CHANNEL_ID, accountId, raw: payload,
    adapter: {
      ingest: () => ({ id: messageId, timestamp, rawText: rawBody, raw: payload }),
      preflight: () => abortSignal?.aborted ? { kind: "drop", reason: "account stopped" } : undefined,
      resolveTurn: async () => {
        onAdmitted?.();
        const media: NonNullable<BuildChannelInboundEventContextParams["media"]> = [];
        if (payload.message.has_attachment && payload.message.attachment) {
          try {
            const { url, filename, content_type } = payload.message.attachment;
            const ssrfPolicy = resolveAttachmentSsrfPolicy(account);
            const fetched = await channel.media.fetchRemoteMedia({ url, ...(ssrfPolicy ? { ssrfPolicy } : {}) });
            const saved = await channel.media.saveMediaBuffer(fetched.buffer, content_type, "inbound", undefined, filename);
            media.push({ path: saved.path, contentType: content_type, fileName: filename });
          } catch (err) {
            logger?.error?.(`[sabha] Failed to download attachment: ${formatStreamError(err)}`);
          }
        }
        const envelope = channel.reply.formatAgentEnvelope({
          channel: CHANNEL_ID, from: `${payload.user.name} (@{${payload.user.id}})`, timestamp,
          envelope: channel.reply.resolveEnvelopeFormatOptions(cfg), body: rawBody,
        });
        const ctxPayload = channel.inbound.buildContext({
          channelIngress: ingress, channel: CHANNEL_ID, accountId, messageId, timestamp,
          from: `sabha:${payload.user.id}`,
          sender: { id: String(payload.user.id), name: payload.user.name },
          conversation: { kind: chatType, id: roomId, label: payload.room.name, nativeChannelId: roomId, threadId: session.threadId },
          route: { agentId: route.agentId, dmScope: route.dmScope, accountId, routeSessionKey: route.sessionKey },
          reply: { to: roomId, originatingTo: roomId, nativeChannelId: roomId, messageThreadId: session.threadId },
          message: { body: envelope, bodyForAgent: rawBody ? envelope : "", rawBody, commandBody: rawBody, inboundEventKind: "user_request" },
          access: { commands: { authorized: ingress.commandAccess.authorized }, ...(!isDm ? { mentions: { canDetectMention: true, wasMentioned: mentioned } } : {}) },
          media,
          extra: { GroupSystemPrompt: !isDm ? account.rooms[roomId]?.systemPrompt?.trim() || undefined : undefined },
        });
        return {
          cfg, channel: CHANNEL_ID, accountId, route, ctxPayload,
          delivery: { deliver, observeMessageSent: true },
          dispatchReplyFromConfig: channel.reply.dispatchReplyFromConfig,
          record: { onRecordError: (error) => logger?.error?.(`[sabha] Session record failed: ${formatStreamError(error)}`) },
          replyOptions: { onPartialReply, disableBlockStreaming: true },
        };
      },
    },
  });
  if (result.dispatched && (readAgentRunTerminalOutcome(result.dispatchResult) === "failed" || Object.values(result.dispatchResult.failedCounts ?? {}).some((count) => count > 0))) {
    throw new Error("Sabha inbound turn failed to settle delivery");
  }
  if (result.dispatched) logger?.info?.(`[sabha] Dispatched ${messageId} in ${roomId}`);
}

// ---------------------------------------------------------------------------
// Edit / delete / boost handlers
// ---------------------------------------------------------------------------
//
// Phase 1.5 wires the dispatch table end-to-end for every message-bearing
// event but keeps the handlers intentionally light: they log at INFO so
// operators can confirm the pipeline is flowing, apply the same self-echo
// and mention filters as `message_created`, and otherwise return. Agent-
// facing semantics (forwarding an edit into the LLM's conversation state,
// propagating a delete, consuming a boost for approval routing) belong to
// Phase 2 — streaming will flesh out edit context and section 2.2
// (approvals via boost reactions) will upgrade `boost_created` to the
// approval handler. The current shape is: "fully typed, fully dispatched,
// ready to grow."

type MessageEventHandlerDeps = {
  botId: number;
  logger?: Logger;
};

export async function handleMessageUpdated(
  payload: SabhaMessageUpdatedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  if (!shouldHandleInbound(payload, deps.botId)) return;
  // Stateless tolerance: the bot may receive `message_updated` for a
  // message it never observed at create time (Scout A, hazard #1 —
  // `Room#bot_memberships_for_events` fires updates to every eligible
  // member, not just the original mention targets). Don't assume prior
  // state. Log and return.
  deps.logger?.info?.(
    `[sabha] message_updated {id=${payload.message.id}, room=${payload.room.name}, from=${payload.user.name}}`,
  );
}

export async function handleMessageDeleted(
  payload: SabhaMessageDeletedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  if (!shouldHandleInbound(payload, deps.botId)) return;
  // Soft-delete: `payload.message.body` is still populated server-side
  // at the moment this event fires. We don't forward the body here
  // because doing so would circumvent the user's intent to delete.
  deps.logger?.info?.(
    `[sabha] message_deleted {id=${payload.message.id}, room=${payload.room.name}, from=${payload.user.name}}`,
  );
}

export async function handleBoostCreated(
  payload: SabhaBoostCreatedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  // Self-echo filter only — boosts are global by design and we do NOT
  // require an @mention on the underlying message to route a boost
  // through the plugin. Phase 2.2 (approval routing) will route boosts
  // on pending-approval messages here before this handler runs.
  if (payload.user.id === deps.botId) return;
  deps.logger?.info?.(
    `[sabha] boost_created {message=${payload.message.id}, boost=${payload.boost.id}, body=${JSON.stringify(payload.boost.body)}, from=${payload.user.name}}`,
  );
}

export async function handleBoostDeleted(
  payload: SabhaBoostDeletedPayload,
  deps: MessageEventHandlerDeps,
): Promise<void> {
  if (payload.user.id === deps.botId) return;
  deps.logger?.info?.(
    `[sabha] boost_deleted {message=${payload.message.id}, boost=${payload.boost.id}, from=${payload.user.name}}`,
  );
}

// ---------------------------------------------------------------------------
// user_* stubs
// ---------------------------------------------------------------------------
//
// PRIVACY INVARIANT: `user_created` and `user_deleted` fan out globally
// across every active bot in the Sabha workspace — see
// `app/controllers/concerns/notify_bots.rb:19-24`. If we forwarded these
// payloads to any agent-visible surface, bot A could observe bot B's
// user-creation patterns, leaking information across bot tenants in the
// same tenant. These stubs exist purely to keep the dispatch table
// complete (so future hooks don't have to re-touch webhook parsing or
// monitor dispatch); they MUST NOT emit the payload through
// the inbound kernel, `formatAgentEnvelope`, or any other
// agent-runtime path. Any future feature wiring `user_*` to a visible
// surface must gate on a per-bot-account opt-in flag and document the
// tradeoff in `docs/ARCHITECTURE.md`.

type UserEventHandlerDeps = {
  logger?: Logger;
};

export async function handleUserCreated(
  payload: SabhaUserCreatedPayload,
  deps: UserEventHandlerDeps,
): Promise<void> {
  // TODO(v1.1+): optional welcome-DM hook, opted into per bot account
  // via `channels.sabha.accounts.<id>.onUserCreated: "welcome-dm"`.
  deps.logger?.debug?.(
    `[sabha] user_created {id=${payload.user.id}, name=${payload.user.name}} — no handler configured`,
  );
}

export async function handleUserDeleted(
  payload: SabhaUserDeletedPayload,
  deps: UserEventHandlerDeps,
): Promise<void> {
  // TODO(v1.1+): user-cleanup hook (e.g. purge cached user state).
  deps.logger?.debug?.(
    `[sabha] user_deleted {id=${payload.user.id}, name=${payload.user.name}} — no handler configured`,
  );
}
