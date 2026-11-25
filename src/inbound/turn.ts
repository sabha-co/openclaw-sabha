// Inbound: one claimed Sabha event becomes an agent turn (messages) or a
// system event on the conversation's session (edits, reactions).
//
// PRIVACY: `user_created` / `user_deleted` fan out to every app in the
// workspace. They never reach this module (see ../monitor/events.ts), and no
// future handler may forward them to an agent-visible surface without a
// per-account opt-in documented in docs/ARCHITECTURE.md.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { BuildChannelInboundEventContextParams } from "openclaw/plugin-sdk/channel-inbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import { isReasoningReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { ssrfPolicyFromAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";
import type { SabhaClient } from "../client/client.js";
import type { SabhaAppEvent, SabhaCommandEvent, SabhaEventChannel, SabhaMessageEvent, SabhaReactionEvent } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { chatTypeOf, isCommandEvent, isMentionGatedChannel, isMessageEvent, isReactionEvent, mentionsApp, type SabhaChatType } from "../monitor/events.js";
import type { SabhaIngressLifecycle } from "../monitor/ingress.js";
import { noteChannelThreading } from "./channel-threading.js";
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
  channelId: string;
  threadId?: string;
  agentId: string;
  dmScope?: ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>["dmScope"];
  sessionKey: string;
};

function resolveConversation(deps: SabhaTurnDeps, event: SabhaMessageEvent | SabhaReactionEvent): Conversation {
  return conversationIn(deps, event.channel, event.message.thread ? String(event.message.thread.id) : undefined);
}

function conversationIn(deps: SabhaTurnDeps, channel: SabhaEventChannel, threadId: string | undefined): Conversation {
  const chatType = chatTypeOf(channel);
  const channelId = String(channel.id);
  const agentRoute = deps.runtime.channel.routing.resolveAgentRoute({
    cfg: deps.cfg, channel: CHANNEL, accountId: deps.account.accountId, peer: { kind: chatType, id: channelId },
  });
  const session = buildSabhaSessionRoute({
    cfg: deps.cfg, agentId: agentRoute.agentId, accountId: deps.account.accountId, channelId, chatType, ...(threadId ? { threadId } : {}),
  });
  return { chatType, channelId, ...(threadId ? { threadId } : {}), agentId: agentRoute.agentId, dmScope: agentRoute.dmScope, sessionKey: session.sessionKey };
}

/** Thread mode: a message in an Open or Closed channel gets its reply in a thread unless replyToMode is off. DMs can't hold threads. */
export function replyTargetFor(event: SabhaMessageEvent, account: Pick<ResolvedSabhaAccount, "replyToMode">): SabhaTarget {
  const threads = isMentionGatedChannel(event.channel) && event.message.thread == null && account.replyToMode !== "off";
  return { channelId: event.channel.id, ...(threads ? { parentMessageId: event.message.id } : {}) };
}

const textOf = (event: SabhaMessageEvent) => (event.message.body.markdown || event.message.body.plain || "").trim();

const userLabel = (user: { id: number; name: string }) => `${user.name} (@{${user.id}})`;
const senderLabel = (event: { user: { id: number; name: string } }) => userLabel(event.user);

/**
 * The message a thread hangs off, which the event names but doesn't carry.
 * Without it an app mentioned in a thread it hasn't been in can't tell what
 * the thread is about. The host shows it only on a session's first turn.
 */
async function threadStarterOf(event: SabhaMessageEvent, deps: SabhaTurnDeps): Promise<string | undefined> {
  const parentId = event.message.thread?.parent_message_id;
  if (parentId == null) return undefined;
  try {
    const parent = await deps.client.getMessage(parentId);
    return `${userLabel(parent.creator)}: ${(parent.body.markdown || parent.body.plain || "").trim()}`;
  } catch (error) {
    deps.log.error?.(`[sabha:${deps.account.accountId}] thread starter ${parentId} lookup failed: ${String(error)}`);
    return "(The message this thread started from couldn't be loaded.)";
  }
}

export async function handleSabhaEvent(event: SabhaAppEvent, lifecycle: SabhaIngressLifecycle, deps: SabhaTurnDeps): Promise<void> {
  if (isMessageEvent(event)) {
    if (event.event === "message_created") return await runMessageTurn(event, lifecycle, deps);
    if (event.event === "message_updated") return await noteEdit(event, deps);
    return;
  }
  if (isReactionEvent(event)) return await noteReaction(event, deps);
  if (isCommandEvent(event)) return await runCommandTurn(event, lifecycle, deps);
}

async function runMessageTurn(event: SabhaMessageEvent, lifecycle: SabhaIngressLifecycle, deps: SabhaTurnDeps): Promise<void> {
  const { runtime, cfg, account, log } = deps;
  const host = runtime.channel;
  const conversation = resolveConversation(deps, event);
  const isDm = conversation.chatType === "direct";
  const messageId = String(event.message.id);
  const rawBody = textOf(event);
  const timestamp = event.message.created_at ? Date.parse(event.message.created_at) : Date.now();
  const mentioned = mentionsApp(event, deps.selfId);

  const access = await resolveSabhaAccess({
    runtime, cfg, account,
    senderId: event.user.id,
    channelId: conversation.channelId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    chatType: conversation.chatType,
    mentioned,
    requireMention: isMentionGatedChannel(event.channel) && !conversation.threadId,
    eventKind: "message",
    hasControlCommand: host.commands.isControlCommandMessage(rawBody, cfg),
    contextBinding: {
      agentId: conversation.agentId, sessionKey: conversation.sessionKey, messageId,
      nativeChannelId: conversation.channelId, inboundEventKind: "user_request",
    },
  });
  if (access.ingress.admission !== "dispatch") {
    log.info?.(`[sabha:${account.accountId}] dropped ${messageId} in ${conversation.channelId} (${access.ingress.reasonCode})`);
    return;
  }
  deps.onInbound?.();
  noteChannelThreading(account.accountId, conversation.channelId, isMentionGatedChannel(event.channel));

  const target = replyTargetFor(event, account);
  const draft = account.livePreview ? createSabhaDraft({ perform: deps.performDraft, target }) : undefined;
  const reply = createSabhaReplyDelivery({
    client: deps.client, runtime, cfg, account, target, ...(draft ? { draft } : {}),
    ...(deps.onOutbound ? { onDelivered: deps.onOutbound } : {}),
    log: (message) => log.info?.(`[sabha:${account.accountId}] ${message}`),
  });

  // Ending the draft happens exactly once: when this call returns, or, for a
  // follow-up deferred to an active run, when the host settles that follow-up
  // (run finished, dropped, cancelled or abandoned).
  let finished: Promise<void> | undefined;
  const finish = (failed: boolean) =>
    (finished ??= reply.finish({ failed }).catch((error: unknown) => log.error?.(`[sabha:${account.accountId}] reply cleanup failed: ${String(error)}`)));
  const turnLifecycle = {
    ...lifecycle,
    onSettled: () => {
      void finish(false);
    },
  };

  let deferredFollowup = false;
  let failed = false;
  try {
    const result = await host.inbound.run({
      channel: CHANNEL,
      accountId: account.accountId,
      raw: event,
      turnAdoptionLifecycle: turnLifecycle,
      adapter: {
        ingest: () => ({ id: messageId, timestamp, rawText: rawBody, textForAgent: rawBody, textForCommands: rawBody, raw: event }),
        resolveTurn: async () => {
          // The working shell shows as soon as the turn is admitted.
          draft?.start();
          const [media, threadStarter] = await Promise.all([downloadAttachment(event, deps), threadStarterOf(event, deps)]);
          const envelope = host.reply.formatAgentEnvelope({
            channel: CHANNEL, from: senderLabel(event), timestamp,
            envelope: host.reply.resolveEnvelopeFormatOptions(cfg), body: rawBody,
          });
          const ctxPayload = host.inbound.buildContext({
            channelIngress: access,
            channel: CHANNEL,
            accountId: account.accountId,
            messageId,
            timestamp,
            from: `sabha:${event.user.id}`,
            sender: { id: String(event.user.id), name: event.user.name },
            conversation: {
              kind: conversation.chatType, id: conversation.channelId, label: event.channel.name ?? undefined,
              nativeChannelId: conversation.channelId, ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
            },
            route: { agentId: conversation.agentId, dmScope: conversation.dmScope, accountId: account.accountId, routeSessionKey: conversation.sessionKey },
            reply: {
              to: conversation.channelId, originatingTo: conversation.channelId, nativeChannelId: conversation.channelId,
              ...(conversation.threadId ? { messageThreadId: conversation.threadId } : {}),
            },
            message: { body: envelope, bodyForAgent: rawBody ? envelope : "", rawBody, commandBody: rawBody, inboundEventKind: "user_request" },
            access: {
              commands: { authorized: access.commandAccess.authorized },
              ...(!isDm ? { mentions: { canDetectMention: true, wasMentioned: mentioned } } : {}),
            },
            media,
            ...(threadStarter ? { supplemental: { thread: { starterBody: threadStarter, senderAllowed: true } } } : {}),
            extra: { GroupSystemPrompt: !isDm ? account.channels[conversation.channelId]?.systemPrompt?.trim() || undefined : undefined },
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
            // Tool starts drive the draft's status line, not chat messages, so they're wanted even
            // while the session's tool progress is hidden.
            replyOptions: {
              onPartialReply: reply.onPartialReply,
              onToolStart: reply.onToolStart,
              allowToolLifecycleWhenProgressHidden: true,
              disableBlockStreaming: true,
            },
          };
        },
      },
    });
    deferredFollowup = result.dispatched && result.dispatchResult.deferredToActiveRun === "followup";
    if (result.dispatched) log.info?.(`[sabha:${account.accountId}] dispatched ${messageId} in ${conversation.channelId}`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A follow-up replies later through this same delivery; onSettled ends its draft.
    if (!deferredFollowup) await finish(failed);
  }
}

/**
 * A member ran one of the app's slash commands. It runs as the host's native
 * command in the conversation it was run in, and the answer goes privately to
 * that member through the event's response_url, as a Slack slash command's does.
 */
async function runCommandTurn(event: SabhaCommandEvent, lifecycle: SabhaIngressLifecycle, deps: SabhaTurnDeps): Promise<void> {
  const { runtime, cfg, account, log } = deps;
  const host = runtime.channel;
  // The event names its channel but not the channel's kind, which decides DM or group.
  // Reading it needs the key's `read` permission; without it the channel counts as a group.
  const channel = await deps.client.getChannel(event.channel_id).catch((error: unknown) => {
    log.error?.(`[sabha:${account.accountId}] channel ${event.channel_id} lookup failed; treating it as a group: ${String(error)}`);
    return { id: event.channel_id, name: event.channel_name, type: event.thread ? "Thread" : "Open" };
  });
  const conversation = conversationIn(deps, channel, event.thread ? String(event.thread.id) : undefined);
  const isDm = conversation.chatType === "direct";
  const commandId = `command:${event.id}`;
  const text = `${event.command} ${event.text ?? ""}`.trim();
  const timestamp = Date.now();

  const access = await resolveSabhaAccess({
    runtime, cfg, account,
    senderId: event.user_id,
    channelId: conversation.channelId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    chatType: conversation.chatType,
    mentioned: true,
    requireMention: false,
    eventKind: "message",
    hasControlCommand: host.commands.isControlCommandMessage(text, cfg),
    contextBinding: {
      agentId: conversation.agentId, sessionKey: conversation.sessionKey, messageId: commandId,
      nativeChannelId: conversation.channelId, inboundEventKind: "user_request",
    },
  });
  if (access.ingress.admission !== "dispatch") {
    log.info?.(`[sabha:${account.accountId}] dropped ${commandId} in ${conversation.channelId} (${access.ingress.reasonCode})`);
    return;
  }
  deps.onInbound?.();

  // Sabha takes five answers per response_url.
  let answers = 0;
  const deliver = async (payload: ReplyPayload) => {
    const reply = payload.text?.trim();
    if (isReasoningReplyPayload(payload) || !reply || answers >= 5) return { visibleReplySent: false } as const;
    answers++;
    await deps.client.respond(event.response_url, reply);
    deps.onOutbound?.();
    return { visibleReplySent: true, content: reply } as const;
  };

  await host.inbound.run({
    channel: CHANNEL,
    accountId: account.accountId,
    raw: event,
    turnAdoptionLifecycle: lifecycle,
    adapter: {
      ingest: () => ({ id: commandId, timestamp, rawText: text, textForAgent: text, textForCommands: text, raw: event }),
      resolveTurn: async () => {
        const envelope = host.reply.formatAgentEnvelope({
          channel: CHANNEL, from: userLabel({ id: event.user_id, name: event.user_name }), timestamp,
          envelope: host.reply.resolveEnvelopeFormatOptions(cfg), body: text,
        });
        const ctxPayload = host.inbound.buildContext({
          channelIngress: access,
          channel: CHANNEL,
          accountId: account.accountId,
          messageId: commandId,
          timestamp,
          from: `sabha:${event.user_id}`,
          sender: { id: String(event.user_id), name: event.user_name },
          conversation: {
            kind: conversation.chatType, id: conversation.channelId, label: event.channel_name ?? undefined,
            nativeChannelId: conversation.channelId, ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
          },
          route: { agentId: conversation.agentId, dmScope: conversation.dmScope, accountId: account.accountId, routeSessionKey: conversation.sessionKey },
          reply: {
            to: conversation.channelId, originatingTo: conversation.channelId, nativeChannelId: conversation.channelId,
            ...(conversation.threadId ? { messageThreadId: conversation.threadId } : {}),
          },
          message: { body: envelope, bodyForAgent: envelope, rawBody: text, commandBody: text, inboundEventKind: "user_request" },
          access: {
            commands: { authorized: access.commandAccess.authorized },
            ...(!isDm ? { mentions: { canDetectMention: true, wasMentioned: true } } : {}),
          },
          extra: {
            CommandSource: "native",
            GroupSystemPrompt: !isDm ? account.channels[conversation.channelId]?.systemPrompt?.trim() || undefined : undefined,
          },
        });
        return {
          cfg, channel: CHANNEL, accountId: account.accountId,
          route: { agentId: conversation.agentId, sessionKey: conversation.sessionKey, ...(conversation.dmScope ? { dmScope: conversation.dmScope } : {}) },
          ctxPayload,
          delivery: {
            observeMessageSent: true,
            deliver,
            onError: (error, info) => log.error?.(`[sabha:${account.accountId}] ${info.kind} command answer failed: ${String(error)}`),
          },
          record: { onRecordError: (error) => log.error?.(`[sabha:${account.accountId}] session record failed: ${String(error)}`) },
          replyOptions: { disableBlockStreaming: true },
        };
      },
    },
  });
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
    channelId: conversation.channelId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    chatType: conversation.chatType,
    mentioned,
    requireMention: kind === "message" && isMentionGatedChannel(event.channel) && !conversation.threadId,
    eventKind: kind,
  });
  const allowed = access.ingress.decision === "allow" && !access.activationAccess.shouldSkip;
  return allowed ? conversation : undefined;
}

const where = (event: SabhaMessageEvent | SabhaReactionEvent) =>
  event.channel.type === "Direct" ? (chatTypeOf(event.channel) === "direct" ? "a direct message" : "a group DM") : `channel ${event.channel.name ?? event.channel.id}`;

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
