import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { SabhaClient } from "./client.js";
import type { SabhaDraftStream } from "./draft-stream.js";
import type { ResolvedSabhaAccount } from "./accounts.js";
import { fetchGuardedAttachment } from "./ssrf-guard.js";

type DeliveryResult = Exclude<Awaited<ReturnType<NonNullable<ChannelInboundTurnPlan["delivery"]>["deliver"]>>, void>;

export async function sendSabhaAttachment(params: {
  client: SabhaClient; account: ResolvedSabhaAccount; roomId: number; url: string; parentMessageId?: number;
}) {
  const fetched = await fetchGuardedAttachment({ url: params.url, account: params.account });
  const blob = new Blob([new Uint8Array(fetched.buffer)], fetched.contentType ? { type: fetched.contentType } : {});
  const sent = await params.client.sendAttachment(params.roomId, blob, fetched.fileName ?? "attachment",
    params.parentMessageId === undefined ? undefined : { parentMessageId: params.parentMessageId });
  if (!sent) throw new Error("Sabha attachment send returned no message receipt");
  return sent;
}

/** The host has already applied modifying hooks to this payload. */
export async function deliverSabhaPayload(params: Parameters<typeof finalizeSabhaReply>[0] & {
  account: ResolvedSabhaAccount; mediaUrls?: readonly string[];
}): Promise<DeliveryResult> {
  const textResult = await finalizeSabhaReply(params);
  const results = [...(textResult.receipt?.raw ?? [])];
  const receipt = () => createMessageReceiptFromOutboundResults({ results, kind: "unknown" });
  try {
    for (const url of params.mediaUrls ?? []) {
      const sent = await sendSabhaAttachment({ ...params, url });
      results.push({ channel: "sabha", messageId: String(sent.id), roomId: String(sent.roomId) });
    }
  } catch (error) {
    if (results.length) throw createChannelPartialDeliveryError(error, {
      content: params.text, visibleReplySent: true, receipt: receipt(),
      messageIds: results.flatMap((result) => result.messageId ? [result.messageId] : []),
    });
    throw error;
  }
  if (!params.mediaUrls?.length) return textResult;
  return { content: params.text, visibleReplySent: true, receipt: receipt(),
    messageIds: results.flatMap((result) => result.messageId ? [result.messageId] : []) };
}

export function sabhaDeliveryResult(text: string, sent: { id: number; roomId: number }): DeliveryResult {
  return {
    content: text,
    visibleReplySent: true,
    messageIds: [String(sent.id)],
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "sabha", messageId: String(sent.id), roomId: String(sent.roomId) }], kind: "text",
    }),
  };
}

/** Settle one preview before reporting a provider-confirmed delivery to core. */
export async function finalizeSabhaReply(params: {
  client: SabhaClient;
  draft: SabhaDraftStream;
  text: string;
  roomId: number;
  parentMessageId?: number;
}): Promise<DeliveryResult> {
  const { client, draft, text, roomId, parentMessageId } = params;
  if (!text.trim()) {
    await draft.clear();
    return { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
  }
  // stop awaits an in-flight first send, even while messageId is still absent.
  if (draft.isAlive()) {
    draft.update(text);
    await draft.stop();
    const sent = draft.sentMessage();
    if (sent && draft.sentText() === text.trimEnd()) return sabhaDeliveryResult(text, sent);
  }
  const preview = draft.sentMessage();
  if (preview) {
    try {
      await client.editMessage(preview.id, text);
      return sabhaDeliveryResult(text, preview);
    } catch {
      // Only replace a stale preview when its deletion is confirmed.
      try {
        await client.deleteMessage(preview.id);
      } catch (error) {
        throw createChannelPartialDeliveryError(error, { ...sabhaDeliveryResult(draft.sentText(), preview), visibleReplySent: true });
      }
    }
  } else if (draft.failure()) {
    // A first send may have reached Sabha; a missing response is not proof of no send.
    throw draft.failure();
  }
  const sent = parentMessageId === undefined
    ? await client.sendMessage(roomId, text)
    : await client.sendMessage(roomId, text, { parentMessageId });
  if (!sent) throw new Error("Sabha accepted a send attempt without returning a message receipt");
  return sabhaDeliveryResult(text, sent);
}
