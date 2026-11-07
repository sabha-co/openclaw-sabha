// One inbound turn's reply custody: the optional live draft, final delivery
// (replacing the draft in place when it can), and media.
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createChannelPartialDeliveryError, isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createLivePreviewLifecycle,
  createMessageReceiptFromOutboundResults,
  type LivePreviewDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { isReasoningReplyPayload, resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { SabhaClient } from "../client/client.js";
import type { SabhaSent } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import type { SabhaDraft } from "./draft-transport.js";
import { acceptedText, sendSabhaMedia, sendSabhaText, type SabhaTarget } from "./send.js";

export type SabhaDeliveryKind = "tool" | "block" | "final";

const NOTHING_VISIBLE: LivePreviewDeliveryResult = { visibleReplySent: false, suppression: { reason: "no_visible_result" } };

export function sabhaDeliveryResult(sent: readonly SabhaSent[], content: string, kind: "text" | "media" | "preview" = "text"): LivePreviewDeliveryResult {
  if (sent.length === 0) return NOTHING_VISIBLE;
  return {
    content,
    visibleReplySent: true,
    messageIds: sent.map((message) => String(message.id)),
    receipt: createMessageReceiptFromOutboundResults({
      results: sent.map((message) => ({ channel: "sabha", messageId: String(message.id), conversationId: String(message.roomId) })),
      kind,
    }),
  };
}

/**
 * Wrap a mid-way failure so core keeps the messages that did land. `content`
 * must be only what landed: core reports it as sent (message_sent hooks too).
 */
export function partialDelivery(error: unknown, sent: readonly SabhaSent[], content: string, kind: "text" | "media" = "text"): unknown {
  if (!sent.length) return error;
  return createChannelPartialDeliveryError(error, { ...sabhaDeliveryResult(sent, content, kind), visibleReplySent: true });
}

export function createSabhaReplyDelivery(params: {
  client: SabhaClient;
  runtime: Pick<PluginRuntime, "channel">;
  cfg?: OpenClawConfig;
  account: ResolvedSabhaAccount;
  target: SabhaTarget;
  draft?: SabhaDraft;
  mediaAccess?: OutboundMediaAccess;
  onDelivered?: () => void;
  log?: (message: string) => void;
}) {
  const { client, account, target, draft } = params;
  const lifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
    ...(draft ? { draft } : {}),
    // A draft holds no delivered content, so ending it never loses anything.
    cleanupUndelivered: true,
    onCleanupFailure: (error) => params.log?.(`sabha draft cleanup failed: ${String(error)}`),
  });

  const postText = async (text: string, clientMessageId?: string): Promise<SabhaSent[]> => {
    const sent: SabhaSent[] = [];
    const chunks: string[] = [];
    try {
      await sendSabhaText({
        client, cfg: params.cfg, accountId: account.accountId, target, text,
        ...(clientMessageId ? { clientMessageId } : {}),
        onSent: (message, chunk) => {
          sent.push(message);
          chunks.push(chunk);
        },
      });
    } catch (error) {
      throw partialDelivery(error, sent, acceptedText(text, chunks));
    }
    return sent;
  };

  // The draft id a failed final posted with. The repost after it reuses the id,
  // so a final that Sabha saved before the failure answers again rather than
  // landing twice, and replaces the draft as the final would have.
  let failedFinalId: string | undefined;

  const deliverNormally = async (payload: ReplyPayload): Promise<LivePreviewDeliveryResult> => {
    const parts = resolveSendableOutboundReplyParts(payload);
    const clientMessageId = failedFinalId;
    failedFinalId = undefined;
    const sent: SabhaSent[] = [];
    if (parts.hasText) {
      sent.push(...(await postText(parts.text, clientMessageId)));
      // It took the draft's place; ending the draft now would remove it.
      if (clientMessageId) draft?.markFinalized();
    }
    try {
      for (const url of parts.mediaUrls) {
        sent.push(await sendSabhaMedia({ client, runtime: params.runtime, account, target, url, ...(params.mediaAccess ? { mediaAccess: params.mediaAccess } : {}) }));
      }
    } catch (error) {
      // All text landed (postText throws otherwise); the media failed.
      throw partialDelivery(error, sent, parts.text, "media");
    }
    if (sent.length) params.onDelivered?.();
    return sabhaDeliveryResult(sent, parts.text, parts.hasMedia ? "media" : "text");
  };

  return {
    lifecycle,
    /**
     * Turn over: release preview custody, then end any draft the final did not
     * replace. The lifecycle keeps undelivered previews on failure, which suits
     * a posted preview but would leave a draft shell spinning.
     */
    finish: async (options: { failed?: boolean } = {}) => {
      try {
        await lifecycle.cleanup(options);
      } finally {
        await draft?.clear();
      }
    },
    /** Full accumulated assistant text, never a delta. */
    onPartialReply: (partialReply: { text?: string }) => {
      if (draft && typeof partialReply.text === "string") draft.update(partialReply.text);
    },
    deliver: async (payload: ReplyPayload, info: { kind: SabhaDeliveryKind }): Promise<LivePreviewDeliveryResult> => {
      if (isReasoningReplyPayload(payload)) return NOTHING_VISIBLE;
      const result = await lifecycle.deliver<{ text: string }>({
        kind: info.kind,
        payload,
        isError: payload.isError,
        adapter: {
          // Only a plain-text final can take over the draft; errors and media post normally
          // and the lifecycle ends the draft.
          buildFinalEdit: (final) => {
            const parts = resolveSendableOutboundReplyParts(final);
            if (!draft?.id() || final.isError || final.presentation || parts.hasMedia || !parts.hasText) return undefined;
            return { text: parts.text };
          },
          editFinal: async (draftId, edit) => {
            try {
              const sent = await postText(edit.text, draftId);
              draft?.markFinalized();
              params.onDelivered?.();
              return sabhaDeliveryResult(sent, edit.text, "preview");
            } catch (error) {
              // The first chunk replaced the draft; it is no longer ours to end.
              if (isChannelPartialDeliveryError(error)) draft?.markFinalized();
              else failedFinalId = draftId;
              throw error;
            }
          },
          // Reposting after a partial final would duplicate the chunks that landed.
          handlePreviewEditError: ({ error }) => (isChannelPartialDeliveryError(error) ? "retain" : "fallback"),
          logPreviewEditFailure: (error) => params.log?.(`sabha final did not replace the draft; posting normally (${String(error)})`),
        },
        deliverNormally,
      });
      return result.deliveryResult ?? NOTHING_VISIBLE;
    },
  };
}

export type SabhaReplyDelivery = ReturnType<typeof createSabhaReplyDelivery>;
