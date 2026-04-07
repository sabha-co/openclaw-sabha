import type { SabhaWebhookPayload, SabhaAccount } from "./types.js";
import { wasBotMentioned, resolveChatType } from "./webhook.js";
import { resolveSessionFromPayload } from "./session.js";

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
// Mention decision is handled inline — Sabha payloads include mentionees array

const CHANNEL_ID = "sabha";

type InboundDeps = {
  runtime: PluginRuntime;
  cfg: any;
  account: SabhaAccount;
  deliver: (payload: any) => Promise<void>;
  logger?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void };
};

/**
 * Process an inbound Sabha webhook event and dispatch it to OpenClaw's reply pipeline.
 */
export async function processInboundMessage(
  payload: SabhaWebhookPayload,
  deps: InboundDeps,
): Promise<void> {
  const { runtime, cfg, account, deliver, logger } = deps;

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
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: chatType,
      id: session.conversationId,
    },
  });

  // Resolve store path
  const storePath = runtime.channel.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  // Build the inbound context
  const envelopeOpts = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const envelope = runtime.channel.reply.formatAgentEnvelope({
    channel: CHANNEL_ID,
    from: payload.user.name,
    timestamp: new Date(payload.message.created_at).getTime(),
    envelope: envelopeOpts,
    body: payload.message.body.plain,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    body: envelope,
    channel: CHANNEL_ID,
    chatType,
    from: payload.user.name,
    accountId,
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
    core: { channel: runtime.channel },
    deliver,
    onRecordError: (err) => {
      logger?.error?.(`[sabha] Session record error: ${err}`);
    },
    onDispatchError: (err, info) => {
      logger?.error?.(`[sabha] Dispatch error (${info.kind}): ${err}`);
    },
  });
}
