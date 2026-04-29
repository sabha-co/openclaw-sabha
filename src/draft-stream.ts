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
 * **Top-level replies that create a new thread stream via `parentMessageId`.**
 * The caller passes `parentMessageId` to the stream; the first send becomes a
 * normal `client.sendMessage(parentRoomId, text, { parentMessageId })` and
 * the server routes the message into the parent's thread room (creating it
 * idempotently via `Rooms::Thread.find_or_create_for`). The response body
 * `{ id, room_id }` carries the resolved thread room id, which the stream
 * captures into `previewRoomId`. The URL room for every send stays
 * `params.roomId` (the parent) — the server validates `parent_message_id`
 * against the URL room's messages — but `previewRoomId` (exposed via
 * `roomId()`) tells fresh-send fallbacks where the preview actually
 * landed so error replacements drop into the thread, not the parent.
 * After the id-only migration `editMessage` / `deleteMessage` don't need
 * either room id (server resolves from the message id). See
 * `docs/plans/ID-ONLY-CLIENT-MIGRATION-PLAN.md`.
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
   * until the first send resolves; after that, equals the room id returned
   * by the server (the input room when `parentMessageId` was unset, or the
   * resolved thread room when it was). After the id-only migration this
   * value is no longer needed for editing or deleting the preview (both
   * are id-only) — it only backs **fresh sends** issued by recovery /
   * error-replace paths so they land in the thread room, not the parent.
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
   * When set, the first send routes the message into the parent message's
   * thread room via the unified `client.sendMessage(parentRoomId, text, {
   * parentMessageId })` call. The URL room is the parent (which the server
   * validates `parent_message_id` against); the server resolves the message
   * into the thread room (idempotent via `Rooms::Thread.find_or_create_for`)
   * and returns `{ id, room_id }` in the response body. The stream captures
   * the resolved thread room id into `previewRoomId` so fresh-send
   * fallbacks land alongside the preview.
   *
   * For non-threading paths (in-thread inbounds, DMs, threading-off),
   * leave this unset — the stream's first send is a regular
   * `sendMessage(roomId, text)` and `previewRoomId` stays at the input
   * `roomId`.
   *
   * Replaces the pre-2026.4.29 `firstSend` callback that wrapped the
   * dedicated `replyInThread` endpoint. See
   * `docs/plans/ID-ONLY-CLIENT-MIGRATION-PLAN.md` Phase 2.
   */
  parentMessageId?: number;
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
  const { client, logger, parentMessageId } = params;

  // `state` is shared by reference with the SDK helper — the helper reads
  // `stopped` / `final` on every flush tick, and our send-or-edit callback
  // mutates `stopped` to halt the loop on errors or the max-chars cap.
  const state = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let lastSentText = "";
  // Two separate room ids. `params.roomId` is the parent (URL room for every
  // POST). `previewRoomId` is the room where the preview message actually
  // landed — equals `params.roomId` for non-thread sends; equals the
  // server-resolved thread room id for parentMessageId-routed sends. They
  // diverge in the threading case because every POST has to target the
  // parent room as the URL (server validates `parent_message_id` against
  // `@room.messages.active`), but fresh-send fallbacks in `monitor.ts`
  // (recovery / error-replace) need the resolved preview room so the new
  // error message lands alongside (and replaces) the preview. `roomId()`
  // exposes `previewRoomId`.
  let previewRoomId = params.roomId;

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
        await client.editMessage(streamMessageId, trimmed);
        lastSentText = trimmed;
        return true;
      }
      // Unified first send. When `parentMessageId` is set, the URL room
      // is still `params.roomId` (the parent) — the server validates
      // `parent_message_id` against the URL room's messages — and the
      // server resolves the routing into the thread room internally
      // (idempotent via `Rooms::Thread.find_or_create_for`). The
      // response body carries the resolved room id, which we capture
      // into `previewRoomId` so fresh-send fallbacks land alongside
      // the preview. When `parentMessageId` is unset, the resolved
      // room is just the input room and the capture is a no-op.
      const sent =
        parentMessageId != null
          ? await client.sendMessage(params.roomId, trimmed, {
              parentMessageId,
            })
          : await client.sendMessage(params.roomId, trimmed);
      if (sent == null) {
        // Sabha's `sendMessage` returns `null` when neither the response
        // body (parentMessageId case) nor the Location header (regular
        // case) yields a usable message id. We can't edit a preview we
        // can't address, so stop.
        state.stopped = true;
        logger?.warn?.(
          "sabha draft stream stopped (sendMessage returned no id)",
        );
        return false;
      }
      previewRoomId = sent.roomId;
      streamMessageId = sent.id;
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
    await client.deleteMessage(messageId);
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
    `sabha draft stream ready (room=${params.roomId}, throttleMs=${throttleMs}, maxChars=${maxChars}${parentMessageId != null ? `, parentMessageId=${parentMessageId}` : ""})`,
  );

  return {
    update,
    flush: loop.flush,
    messageId: readMessageId,
    roomId: () => previewRoomId,
    isAlive: () => !state.stopped,
    clear,
    stop,
    forceNewMessage,
  };
}
