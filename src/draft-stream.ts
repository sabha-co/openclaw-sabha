import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import type { SabhaClient } from "./client.js";

/**
 * Render an error as a safe, bounded user-visible string.
 *
 * `SabhaApiError` puts the fully-formed fetch URL — including the
 * `bot_key` path segment — inside its message (see `client.ts`, where
 * `throw new SabhaApiError(status, body, url)` and the super constructor
 * interpolates the url). Using `String(err)` on one of those errors
 * would PATCH the bot key into a public room message. Redact the
 * `{id}-{token}` pattern before it reaches any user-facing surface.
 *
 * Also trims to 500 chars so an LLM stack trace or a giant JSON error
 * body doesn't dwarf the reply.
 *
 * Exported because the monitor / webhook error paths use it to build
 * the Q12 error-replace text before calling `editMessage` directly.
 */
export function formatStreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Bot keys are `{numeric-id}-{token}` with a token of at least ~10
  // alphanumeric chars. The numeric prefix is short (1-6 digits) and the
  // token is URL-safe; matching `\d{1,8}-[A-Za-z0-9]{10,}` catches the
  // full key without over-redacting unrelated identifiers like commit
  // hashes or timestamps with a leading digit group.
  const redacted = raw.replace(/\d{1,8}-[A-Za-z0-9]{10,}/g, "***");
  return redacted.length > 500 ? redacted.slice(0, 500) + "…" : redacted;
}

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
 * **In-thread inbounds stream directly into the thread room.** Sabha emits
 * `payload.room.id == payload.message.thread.id` for in-thread events, so
 * `createSabhaDraftStream({ roomId: payload.room.id })` already targets the
 * right room.
 *
 * **Top-level replies that create a NEW thread stream via `firstSend`.** The
 * caller supplies a `firstSend` callback that posts the first partial via
 * `replyInThread`, captures the new thread room id from the response, and
 * returns it. The stream rebinds its room id to the captured value so all
 * subsequent `editMessage` / `deleteMessage` calls target the thread, not the
 * parent room. `roomId()` exposes the captured value to callers (recovery /
 * error-replace paths) so they don't reach for the parent room id and 404.
 */
export type SabhaDraftStream = {
  /** Set the current accumulated text. The loop throttles the actual send. */
  update: (text: string) => void;
  /** Flush any pending edit and wait for it to settle. */
  flush: () => Promise<void>;
  /** Current stream message id, or undefined if nothing has been sent yet. */
  messageId: () => number | undefined;
  /**
   * Effective room id for the preview message. Equals the param `roomId`
   * until `firstSend` is wired and resolves; after that, equals the captured
   * thread room id (so callers can `editMessage` / `deleteMessage` against
   * the right room in recovery / error-replace paths).
   */
  roomId: () => number;
  /**
   * `true` while the loop can still accept `update` calls. Flips to
   * `false` the moment `sendOrEditStreamMessage` short-circuits due to an
   * error, a null message id, or the max-chars cap. Callers in the
   * `deliver` and error-replace paths MUST check this before routing
   * finalization through `update` / `stop` — once the stream is dead
   * the SDK's controls wrapper silently drops updates, and a caller
   * assuming success would leave the preview stuck on the last partial.
   */
  isAlive: () => boolean;
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
  /**
   * Optional override for the very first send. When supplied, the first
   * partial is routed through this callback instead of `client.sendMessage`,
   * and the returned `{ roomId, messageId }` rebinds the stream's effective
   * room for all subsequent edits and deletes.
   *
   * Used by the threading-on streaming path: the callback posts via
   * `client.replyInThread(parentRoomId, userMessageId, text)`, reads the
   * new thread room id from the response (`r.thread.id`), and returns it
   * along with `r.message.id`. Sabha's `/thread` endpoint is idempotent
   * via `find_or_create_for`, so a network-drop retry can't fork the
   * thread.
   *
   * Returning `null` is treated like `sendMessage` returning `null`: the
   * stream stops and the caller's `deliver` fast-path handles finalization
   * via the dead-stream branches.
   */
  firstSend?: (
    text: string,
  ) => Promise<{ roomId: number; messageId: number } | null>;
  throttleMs?: number;
  maxChars?: number;
  logger?: DraftStreamLogger;
};

export function createSabhaDraftStream(
  params: CreateSabhaDraftStreamParams,
): SabhaDraftStream {
  const requestedThrottleMs = params.throttleMs ?? DEFAULT_THROTTLE_MS;
  const throttleMs = Math.max(250, requestedThrottleMs);
  if (throttleMs !== requestedThrottleMs) {
    // Surface the clamp so operators don't silently get a different value
    // than they configured. 250ms is a hard floor: below that the SDK
    // loop starts to schedule faster than Sabha can comfortably serve
    // PATCHes, and Phase 1's retry runner ends up doing the smoothing
    // instead of the throttle itself.
    params.logger?.warn?.(
      `sabha draft stream throttleMs=${requestedThrottleMs} clamped to floor 250`,
    );
  }
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
  const { client, logger, firstSend } = params;

  // `state` is shared by reference with the SDK helper — the helper reads
  // `stopped` / `final` on every flush tick, and our send-or-edit callback
  // mutates `stopped` to halt the loop on errors or the max-chars cap.
  const state = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let lastSentText = "";
  // `effectiveRoomId` starts at the configured room and gets rebound to the
  // thread room id once `firstSend` resolves (see the threading-on streaming
  // path). All `editMessage` / `deleteMessage` calls below MUST read this
  // variable, not the original `params.roomId`, otherwise post-thread edits
  // and the `clear()` deletion would target the parent room.
  let effectiveRoomId = params.roomId;

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

    // Dedup against the last *successfully sent* text. We deliberately
    // don't mutate `lastSentText` until after the await succeeds — if we
    // mutated it optimistically and the send then threw, a caller doing
    // a legitimate retry with the same snapshot would hit this dedup
    // branch and silently skip the retry. See also the "coupled invariant"
    // discussion in the commit that added `isAlive()`.
    if (trimmed === lastSentText) return true;

    try {
      if (streamMessageId !== undefined) {
        await client.editMessage(effectiveRoomId, streamMessageId, trimmed);
        lastSentText = trimmed;
        return true;
      }
      if (firstSend) {
        // First-send override (threading-on path). The callback posts the
        // initial partial via `replyInThread` and returns the new thread's
        // room id along with the first message id. Subsequent ticks fall
        // into the `streamMessageId !== undefined` branch above and target
        // `effectiveRoomId` (the captured thread room).
        const sent = await firstSend(trimmed);
        if (sent == null) {
          state.stopped = true;
          logger?.warn?.(
            "sabha draft stream stopped (firstSend returned null)",
          );
          return false;
        }
        effectiveRoomId = sent.roomId;
        streamMessageId = sent.messageId;
        lastSentText = trimmed;
        return true;
      }
      const sentId = await client.sendMessage(effectiveRoomId, trimmed);
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
      lastSentText = trimmed;
      return true;
    } catch (err) {
      state.stopped = true;
      logger?.warn?.(
        `sabha draft stream failed: ${formatStreamError(err)}`,
      );
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
    await client.deleteMessage(effectiveRoomId, messageId);
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
    `sabha draft stream ready (room=${params.roomId}, throttleMs=${throttleMs}, maxChars=${maxChars}${firstSend ? ", firstSend=on" : ""})`,
  );

  return {
    update,
    flush: loop.flush,
    messageId: readMessageId,
    roomId: () => effectiveRoomId,
    isAlive: () => !state.stopped,
    clear,
    stop,
    forceNewMessage,
  };
}
