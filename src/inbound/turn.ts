// Inbound: one claimed Sabha event becomes an agent turn (messages) or a
// system event on the conversation's session (edits, reactions).
//
// PRIVACY: `user_created` / `user_deleted` fan out to every app in the
// workspace. They never reach this module (see ../monitor/events.ts), and no
// future handler may forward them to an agent-visible surface without a
// per-account opt-in documented in docs/ARCHITECTURE.md.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { BuildChannelInboundEventContextParams } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { ssrfPolicyFromAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";
import type { SabhaClient } from "../client/client.js";
import type { SabhaAppEvent, SabhaMessageEvent, SabhaReactionEvent } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { chatTypeOf, isMentionGatedRoom, isMessageEvent, isReactionEvent, mentionsApp, type SabhaChatType } from "../monitor/events.js";
import type { SabhaIngressLifecycle } from "../monitor/ingress.js";
import { createSabhaDraft, type PerformDraft } from "../outbound/draft-transport.js";
import { createSabhaReplyDelivery } from "../outbound/reply-delivery.js";
import { SABHA_MEDIA_MAX_BYTES, type SabhaTarget } from "../outbound/send.js";
import { buildSabhaSessionRoute } from "../session.js";
import { resolveSabhaAccess } from "./access.js";

const CHANNEL = "sabha";

export type SabhaTurnDeps = {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  account: ResolvedSabhaAccount;
  selfId: number;
  client: SabhaClient;
  /** Sends a draft frame on the live cable session; false when disconnected. */
  performDraft: PerformDraft;
  log: { info?: (message: string) => void; error?: (message: string) => void };
  onInbound?: () => void;
  onOutbound?: () => void;
};

type Conversation = {
  chatType: SabhaChatType;
  roomId: string;
  threadId?: string;
  agentId: string;
  dmScope?: ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>["dmScope"];
  sessionKey: string;
};

function resolveConversation(deps: SabhaTurnDeps, event: SabhaMessageEvent | SabhaReactionEvent): Conversation {
  const chatType = chatTypeOf(event.room);
  const roomId = String(event.room.id);
  const threadId = event.message.thread ? String(event.message.thread.id) : undefined;
  const agentRoute = deps.runtime.channel.routing.resolveAgentRoute({
    cfg: deps.cfg, channel: CHANNEL, accountId: deps.account.accountId, peer: { kind: chatType, id: roomId },
  });
  const session = buildSabhaSessionRoute({
    cfg: deps.cfg, agentId: agentRoute.agentId, accountId: deps.account.accountId, roomId, chatType, ...(threadId ? { threadId } : {}),
  });
  return { chatType, roomId, ...(threadId ? { threadId } : {}), agentId: agentRoute.agentId, dmScope: agentRoute.dmScope, sessionKey: session.sessionKey };
}

/** Thread mode: a message in an Open or Closed room gets its reply in a thread unless replyToMode is off. DMs can't hold threads. */
export function replyTargetFor(event: SabhaMessageEvent, account: Pick<ResolvedSabhaAccount, "replyToMode">): SabhaTarget {
  const threads = isMentionGatedRoom(event.room) && event.message.thread == null && account.replyToMode !== "off";
  return { roomId: event.room.id, ...(threads ? { parentMessageId: event.message.id } : {}) };
}

const textOf = (event: SabhaMessageEvent) => (event.message.body.markdown || event.message.body.plain || "").trim();

const senderLabel = (event: { user: { id: number; name: string } }) => `${event.user.name} (@{${event.user.id}})`;

export async function handleSabhaEvent(event: SabhaAppEvent, lifecycle: SabhaIngressLifecycle, deps: SabhaTurnDeps): Promise<void> {
  if (isMessageEvent(event)) {
    if (event.event === "message_created") return await runMessageTurn(event, lifecycle, deps);
    if (event.event === "message_updated") return await noteEdit(event, deps);
    return;
  }
  if (isReactionEvent(event)) return await noteReaction(event, deps);
}

async function runMessageTurn(event: SabhaMessageEvent, lifecycle: SabhaIngressLifecycle, deps: SabhaTurnDeps): Promise<void> {
  const { runtime, cfg, account, log } = deps;
  const channel = runtime.channel;
  const conversation = resolveConversation(deps, event);
  const isDm = conversation.chatType === "direct";
  const messageId = String(event.message.id);
  const rawBody = textOf(event);
  const timestamp = event.message.created_at ? Date.parse(event.message.created_at) : Date.now();
  const mentioned = mentionsApp(event, deps.selfId);

  const access = await resolveSabhaAccess({
    runtime, cfg, account,
    senderId: event.user.id,
    roomId: conversation.roomId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    chatType: conversation.chatType,
    mentioned,
    requireMention: isMentionGatedRoom(event.room) && !conversation.threadId,
    eventKind: "message",
    hasControlCommand: channel.commands.isControlCommandMessage(rawBody, cfg),
    contextBinding: {
      agentId: conversation.agentId, sessionKey: conversation.sessionKey, messageId,
      nativeChannelId: conversation.roomId, inboundEventKind: "user_request",
    },
  });
  if (access.ingress.admission !== "dispatch") {
    log.info?.(`[sabha:${account.accountId}] dropped ${messageId} in ${conversation.roomId} (${access.ingress.reasonCode})`);
    return;
  }
  deps.onInbound?.();

  const target = replyTargetFor(event, account);
  const draft = account.livePreview ? createSabhaDraft({ perform: deps.performDraft, target }) : undefined;
  const reply = createSabhaReplyDelivery({
    client: deps.client, runtime, cfg, account, target, ...(draft ? { draft } : {}),
    ...(deps.onOutbound ? { onDelivered: deps.onOutbound } : {}),
    log: (message) => log.info?.(`[sabha:${account.accountId}] ${message}`),
  });

  let deferredFollowup = false;
  let failed = false;
  try {
    const result = await channel.inbound.run({
      channel: CHANNEL,
      accountId: account.accountId,
      raw: event,
      turnAdoptionLifecycle: lifecycle,
      adapter: {
        ingest: () => ({ id: messageId, timestamp, rawText: rawBody, textForAgent: rawBody, textForCommands: rawBody, raw: event }),
        resolveTurn: async () => {
          // The working shell shows as soon as the turn is admitted.
          draft?.start();
          const media = await downloadAttachment(event, deps);
          const envelope = channel.reply.formatAgentEnvelope({
            channel: CHANNEL, from: senderLabel(event), timestamp,
            envelope: channel.reply.resolveEnvelopeFormatOptions(cfg), body: rawBody,
          });
          const ctxPayload = channel.inbound.buildContext({
            channelIngress: access,
            channel: CHANNEL,
            accountId: account.accountId,
            messageId,
            timestamp,
            from: `sabha:${event.user.id}`,
            sender: { id: String(event.user.id), name: event.user.name },
            conversation: {
              kind: conversation.chatType, id: conversation.roomId, label: event.room.name ?? undefined,
              nativeChannelId: conversation.roomId, ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
            },
            route: { agentId: conversation.agentId, dmScope: conversation.dmScope, accountId: account.accountId, routeSessionKey: conversation.sessionKey },
            reply: {
              to: conversation.roomId, originatingTo: conversation.roomId, nativeChannelId: conversation.roomId,
              ...(conversation.threadId ? { messageThreadId: conversation.threadId } : {}),
            },
            message: { body: envelope, bodyForAgent: rawBody ? envelope : "", rawBody, commandBody: rawBody, inboundEventKind: "user_request" },
            access: {
              commands: { authorized: access.commandAccess.authorized },
              ...(!isDm ? { mentions: { canDetectMention: true, wasMentioned: mentioned } } : {}),
            },
            media,
            extra: { GroupSystemPrompt: !isDm ? account.rooms[conversation.roomId]?.systemPrompt?.trim() || undefined : undefined },
          });
          return {
            cfg, channel: CHANNEL, accountId: account.accountId,
            route: { agentId: conversation.agentId, sessionKey: conversation.sessionKey, ...(conversation.dmScope ? { dmScope: conversation.dmScope } : {}) },
            ctxPayload,
            delivery: {
              observeMessageSent: true,
              deliver: (payload, info) => reply.deliver(payload, info),
              onError: (error, info) => log.error?.(`[sabha:${account.accountId}] ${info.kind} reply failed: ${String(error)}`),
            },
            record: { onRecordError: (error) => log.error?.(`[sabha:${account.accountId}] session record failed: ${String(error)}`) },
            replyOptions: { onPartialReply: reply.onPartialReply, disableBlockStreaming: true },
          };
        },
      },
    });
    deferredFollowup = result.dispatched && result.dispatchResult.deferredToActiveRun === "followup";
    if (result.dispatched) log.info?.(`[sabha:${account.accountId}] dispatched ${messageId} in ${conversation.roomId}`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A follow-up replies later through this same delivery; its draft is still live.
    if (!deferredFollowup) await reply.finish({ failed });
  }
}

async function downloadAttachment(event: SabhaMessageEvent, deps: SabhaTurnDeps): Promise<NonNullable<BuildChannelInboundEventContextParams["media"]>> {
  const attachment = event.message.attachment;
  if (!attachment?.url) return [];
  try {
    const saved = await deps.runtime.channel.media.saveRemoteMedia({
      url: attachment.url,
      maxBytes: SABHA_MEDIA_MAX_BYTES,
      subdir: "inbound",
      originalFilename: attachment.filename,
      fallbackContentType: attachment.content_type,
      ...(deps.account.allowPrivateNetwork ? { ssrfPolicy: ssrfPolicyFromAllowPrivateNetwork(true) } : {}),
    });
    return [{ path: saved.path, contentType: saved.contentType ?? attachment.content_type, fileName: attachment.filename }];
  } catch (error) {
    deps.log.error?.(`[sabha:${deps.account.accountId}] attachment download failed: ${String(error)}`);
    return [];
  }
}

/** Edits and reactions are context for the conversation's next turn, not turns of their own. */
async function admitSystemEvent(event: SabhaMessageEvent | SabhaReactionEvent, deps: SabhaTurnDeps, kind: "message" | "reaction") {
  const conversation = resolveConversation(deps, event);
  const mentioned = isMessageEvent(event) && mentionsApp(event, deps.selfId);
  const access = await resolveSabhaAccess({
    runtime: deps.runtime, cfg: deps.cfg, account: deps.account,
    senderId: event.user.id,
    roomId: conversation.roomId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    chatType: conversation.chatType,
    mentioned,
    requireMention: kind === "message" && isMentionGatedRoom(event.room) && !conversation.threadId,
    eventKind: kind,
  });
  const allowed = access.ingress.decision === "allow" && !access.activationAccess.shouldSkip;
  return allowed ? conversation : undefined;
}

const where = (event: SabhaMessageEvent | SabhaReactionEvent) =>
  event.room.type === "Direct" ? (chatTypeOf(event.room) === "direct" ? "a direct message" : "a group DM") : `room ${event.room.name ?? event.room.id}`;

async function noteEdit(event: SabhaMessageEvent, deps: SabhaTurnDeps) {
  const conversation = await admitSystemEvent(event, deps, "message");
  if (!conversation) return;
  const text = `Sabha message ${event.message.id} edited by ${senderLabel(event)} in ${where(event)}. New text:\n${textOf(event)}`;
  deps.runtime.system.enqueueSystemEvent(text, {
    sessionKey: conversation.sessionKey,
    contextKey: `sabha:edit:${event.message.id}:${event.message.updated_at ?? ""}`,
  });
}

async function noteReaction(event: SabhaReactionEvent, deps: SabhaTurnDeps) {
  const conversation = await admitSystemEvent(event, deps, "reaction");
  if (!conversation) return;
  const action = event.event === "reaction_created" ? "added" : "removed";
  const text = `Sabha reaction ${action}: ${event.reaction.body} by ${senderLabel(event)} on message ${event.message.id} in ${where(event)}`;
  deps.runtime.system.enqueueSystemEvent(text, {
    sessionKey: conversation.sessionKey,
    contextKey: `sabha:reaction:${event.reaction.id}:${action}`,
  });
}
