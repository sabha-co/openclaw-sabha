// Heavy transport graph, imported lazily by channel.ts so loading the plugin
// (status, setup, discovery) never pulls in the socket, ingress or client.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { clientFor } from "../client/account-client.js";
import { resolveSabhaAccount } from "../config/accounts.js";
import { sendSabhaMedia } from "../outbound/send.js";
import { resolveSendTarget } from "../outbound/target.js";
import { getSabhaRuntime } from "../runtime.js";

export { monitorSabhaAccount } from "../monitor/monitor.js";

type SendContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  threadId?: string | number | null;
  replyToId?: string | null;
  signal?: AbortSignal;
};

/** One already-chunked text part (the host chunks before calling sendText). */
export async function sendText(ctx: SendContext & { text: string }) {
  const account = resolveSabhaAccount(ctx.cfg, ctx.accountId);
  const client = clientFor(account, ctx.signal);
  const target = await resolveSendTarget({ client, to: ctx.to, threadId: ctx.threadId, replyToId: ctx.replyToId });
  const sent = await client.sendMessage(target.roomId, ctx.text, target.parentMessageId !== undefined ? { parentMessageId: target.parentMessageId } : {});
  return { messageId: String(sent.id), conversationId: String(sent.roomId) };
}

export async function sendMedia(ctx: SendContext & { mediaUrl: string; mediaAccess?: OutboundMediaAccess }) {
  const account = resolveSabhaAccount(ctx.cfg, ctx.accountId);
  const client = clientFor(account, ctx.signal);
  const target = await resolveSendTarget({ client, to: ctx.to, threadId: ctx.threadId, replyToId: ctx.replyToId });
  const sent = await sendSabhaMedia({
    client, runtime: getSabhaRuntime(), account, target, url: ctx.mediaUrl,
    ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
  });
  return { messageId: String(sent.id), conversationId: String(sent.roomId) };
}
