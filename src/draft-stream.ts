import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import type { SabhaClient } from "./client.js";

/**
 * Throttle budget for streaming edits. Matches the Phase 2 gate decision
 * (Q10): ~2 edits/sec. Conservative vs Slack/Discord (3-5/sec) because
 * Sabha's Turbo Stream rebroadcast is untested at higher rates — see Q11
 * for the "ship and measure" rationale. Not operator-configurable in v1.
 */
const DEFAULT_THROTTLE_MS = 500;

/**
 * Soft cap on the streamed preview text. Sabha's message body column has
 * no hard limit, but past this length an agent reply should probably be
 * split into multiple messages anyway. Stopping the preview at the cap
 * avoids hammering `PATCH /messages/:id` with bodies that get harder to
 * edit as they grow.
 */
const DEFAULT_MAX_CHARS = 16_000;

/**
 * Streaming draft preview for Sabha. Wraps the SDK's finalizable
 * draft-stream lifecycle so partial agent outputs land as a single message
 * that edits in place as the LLM yields more text.
 *
 * The API mirrors Discord's `DiscordDraftStream` — callers pass the full
 * accumulated text snapshot to `update` on every partial (not deltas),
 * and the lifecycle helper throttles the actual `sendMessage` /
 * `editMessage` calls to roughly `throttleMs` apart.
 *
 * **Not used for thread replies in v1.** Streaming a reply into a thread
 * requires a first `replyInThread` to capture the thread sub-room id,
 * then subsequent `editMessage` calls against that sub-room. For Phase 2.1
 * we only stream top-level room replies and fall back to the non-streaming
 * path for threads; thread streaming is a follow-up.
 */
export type SabhaDraftStream = {
  /** Set the current accumulated text. The loop throttles the actual send. */
  update: (text: string) => void;
  /** Flush any pending edit and wait for it to settle. */
  flush: () => Promise<void>;
  /** Current stream message id, or undefined if nothing has been sent yet. */
  messageId: () => number | undefined;
  /** Delete the preview message (if any) and stop the loop. */
  clear: () => Promise<void>;
  /** Finalize the stream: mark final, drain the last text, guarantee one last edit. */
  stop: () => Promise<void>;
  /** Reset so the next `update` creates a new message instead of editing the current one. */
  forceNewMessage: () => void;
};

type DraftStreamLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export type CreateSabhaDraftStreamParams = {
  client: SabhaClient;
  roomId: number;
  throttleMs?: number;
  maxChars?: number;
  logger?: DraftStreamLogger;
};

export function createSabhaDraftStream(
  params: CreateSabhaDraftStreamParams,
): SabhaDraftStream {
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
  const { client, roomId, logger } = params;

  // `state` is shared by reference with the SDK helper — the helper reads
  // `stopped` / `final` on every flush tick, and our send-or-edit callback
  // mutates `stopped` to halt the loop on errors or the max-chars cap.
  const state = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let lastSentText = "";

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // The final flush runs even after an explicit stop (e.g. `clear()`),
    // which is how the SDK guarantees the last text lands. Let it through
    // only when the state says we're finalizing — otherwise honor the stop.
    if (state.stopped && !state.final) return false;

    const trimmed = text.trimEnd();
    if (!trimmed) return false;

    if (trimmed.length > maxChars) {
      // Permanently stop the loop — every subsequent update will be a
      // superset and we don't want to ping-pong between "send" and "too
      // long" on every tick. The final deliver path still posts the full
      // text through the non-streaming code.
      state.stopped = true;
      logger?.warn?.(
        `sabha draft stream stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return false;
    }

    if (trimmed === lastSentText) return true;

    // Optimistically record what we're about to send so a duplicate
    // callback from the loop (can happen if `flush` races a scheduled
    // tick) dedups instead of re-PATCHing the same text.
    lastSentText = trimmed;

    try {
      if (streamMessageId !== undefined) {
        await client.editMessage(roomId, streamMessageId, trimmed);
        return true;
      }
      const sentId = await client.sendMessage(roomId, trimmed);
      if (sentId == null) {
        // Sabha's `sendMessage` returns `null` when the Location header
        // is missing. We can't edit a preview we can't address, so stop.
        state.stopped = true;
        logger?.warn?.(
          "sabha draft stream stopped (sendMessage returned no id)",
        );
        return false;
      }
      streamMessageId = sentId;
      return true;
    } catch (err) {
      state.stopped = true;
      logger?.warn?.(`sabha draft stream failed: ${String(err)}`);
      return false;
    }
  };

  const readMessageId = () => streamMessageId;
  const clearMessageId = () => {
    streamMessageId = undefined;
    lastSentText = "";
  };
  const isValidMessageId = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const deleteMessage = async (messageId: number) => {
    await client.deleteMessage(roomId, messageId);
  };

  const { loop, update, stop, clear } = createFinalizableDraftLifecycle<number>({
    throttleMs,
    state,
    sendOrEditStreamMessage,
    readMessageId,
    clearMessageId,
    isValidMessageId,
    deleteMessage,
    warn: logger?.warn,
    warnPrefix: "sabha stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  logger?.debug?.(
    `sabha draft stream ready (room=${roomId}, throttleMs=${throttleMs}, maxChars=${maxChars})`,
  );

  return {
    update,
    flush: loop.flush,
    messageId: readMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}
