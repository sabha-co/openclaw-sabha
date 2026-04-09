import type { SabhaWebhookPayload, SabhaAccount, DeliveryPayload } from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { wasBotMentioned, resolveChatType } from "./webhook.js";
import { resolveSessionFromPayload } from "./session.js";

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";

type ChannelRuntime = PluginRuntime["channel"];

const CHANNEL_ID = "sabha";

type InboundDeps = {
  runtime: PluginRuntime | ChannelRuntime;
  cfg: OpenClawConfig;
  account: SabhaAccount;
  deliver: (payload: DeliveryPayload) => Promise<void>;
  logger?: { info?: (message: string) => void; error?: (message: string) => void };
};

/**
 * Process an inbound Sabha webhook event and dispatch it to OpenClaw's reply pipeline.
 */
export async function processInboundMessage(
  payload: SabhaWebhookPayload,
  deps: InboundDeps,
): Promise<void> {
  const { runtime: runtimeOrChannel, cfg, account, deliver, logger } = deps;

  // Normalize: accept either PluginRuntime or ChannelRuntime directly
  const channel: ChannelRuntime = "channel" in runtimeOrChannel
    ? (runtimeOrChannel as PluginRuntime).channel
    : runtimeOrChannel as ChannelRuntime;

  // Skip messages from the bot itself
  if (payload.user.id === account.botId) return;

  const chatType = resolveChatType(payload.room.type);
  const isDm = chatType === "direct";
  const mentioned = wasBotMentioned(payload, account.botId);

  // In groups, only respond when mentioned (unless DM)
  if (!isDm && !mentioned) return;

  const session = resolveSessionFromPayload(payload);
  const accountId = account.accountId ?? "";

  // Resolve agent route
  const route = channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: chatType,
      id: session.conversationId,
    },
  });

  // Resolve store path
  const storePath = channel.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  // Download attachment immediately (signed URLs expire after 1 hour)
  let attachmentPath: string | undefined;
  if (payload.message.has_attachment && payload.message.attachment) {
    try {
      const { url, filename, content_type } = payload.message.attachment;
      const fetched = await channel.media.fetchRemoteMedia({ url });
      const saved = await channel.media.saveMediaBuffer(
        fetched.buffer,
        content_type,
        "inbound",
        undefined,
        filename,
      );
      attachmentPath = saved.id;
    } catch (err) {
      logger?.error?.(`[sabha] Failed to download attachment: ${err}`);
    }
  }

  // Build raw message body (clean text for the LLM)
  const rawBody = payload.message.body.plain;

  // Build body with attachment context if present
  const bodyWithAttachment = attachmentPath
    ? `${rawBody}\n\n[Attachment: ${payload.message.attachment!.filename} — saved to ${attachmentPath}]`
    : rawBody;

  // Build the formatted envelope (with sender/timestamp context)
  const envelopeOpts = channel.reply.resolveEnvelopeFormatOptions(cfg);
  const envelope = channel.reply.formatAgentEnvelope({
    channel: CHANNEL_ID,
    from: payload.user.name,
    timestamp: new Date(payload.message.created_at).getTime(),
    envelope: envelopeOpts,
    body: bodyWithAttachment,
  });

  // Build the inbound context with PascalCase field names (MsgContext)
  const ctxPayload = channel.reply.finalizeInboundContext({
    Body: envelope,
    BodyForAgent: envelope,
    RawBody: rawBody,
    BodyForCommands: rawBody,
    CommandBody: rawBody,
    From: payload.user.name,
    SenderId: String(payload.user.id),
    SenderName: payload.user.name,
    To: String(payload.room.id),
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: payload.room.name,
    Timestamp: new Date(payload.message.created_at).getTime(),
    MessageSid: String(payload.message.id),
    ...(session.threadId ? {
      ReplyToId: session.threadId,
      ParentSessionKey: session.baseConversationId
        ? route.sessionKey
        : undefined,
    } : {}),
    ...(attachmentPath ? {
      MediaPath: attachmentPath,
    } : {}),
  });

  logger?.info?.(
    `[sabha] Dispatching: ${payload.event} from ${payload.user.name} in ${payload.room.name}`,
  );

  // Record session and dispatch reply
  await dispatchInboundReplyWithBase({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    route,
    storePath,
    ctxPayload,
    core: { channel },
    deliver,
    onRecordError: (err) => {
      logger?.error?.(`[sabha] Session record error: ${err}`);
    },
    onDispatchError: (err, info) => {
      logger?.error?.(`[sabha] Dispatch error (${info.kind}): ${err}`);
    },
  });
}
