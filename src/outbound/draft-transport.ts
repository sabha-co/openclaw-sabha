// Live draft over AppEventsChannel `draft` frames (sabha-ai Part A).
//
// A draft is UI-only: Sabha broadcasts it to viewers and never stores it. The
// final reply posts with `client_message_id = draft id`, which gives the new
// message the draft's DOM id so it replaces the draft in place. That means no
// preview message ever exists: nothing to edit, delete or repair. `end` tears
// down a draft that produced no message.
//
// Older servers ignore the unknown `draft` action, and the final post simply
// appears as a normal message.
import { randomUUID } from "node:crypto";
import type { SabhaDraftFrame } from "../client/types.js";
import type { SabhaTarget } from "./send.js";

export const DRAFT_THROTTLE_MS = 250;
/** Matches the server's per-draft text cap; longer snapshots stop updating the draft. */
export const DRAFT_MAX_CHARS = 16_000;

export type PerformDraft = (frame: SabhaDraftFrame) => boolean;

export type SabhaDraft = {
  /** Show the working shell now (before any text). */
  start: () => void;
  /** Full accumulated text snapshot; frames are coalesced to the throttle. */
  update: (text: string) => void;
  flush: () => Promise<void>;
  /** The draft id once the shell was sent, which is also the final's client_message_id. */
  id: () => string | undefined;
  seal: () => Promise<void>;
  discardPending: () => Promise<void>;
  /**
   * End a draft that produced no message. Idempotent; resolves true because a
   * draft that never started or was replaced has nothing left to remove.
   */
  clear: () => Promise<true>;
  /** The final message replaced the draft; nothing left to end. */
  markFinalized: () => void;
};

export function createSabhaDraft(params: {
  perform: PerformDraft;
  target: SabhaTarget;
  throttleMs?: number;
  maxChars?: number;
  newId?: () => string;
}): SabhaDraft {
  const throttleMs = params.throttleMs ?? DRAFT_THROTTLE_MS;
  const maxChars = params.maxChars ?? DRAFT_MAX_CHARS;
  const draftId = (params.newId ?? randomUUID)();
  const where = {
    draft_id: draftId,
    room_id: params.target.roomId,
    ...(params.target.parentMessageId !== undefined ? { parent_message_id: params.target.parentMessageId } : {}),
  };

  let started = false;
  let closed = false; // sealed, finalized or ended: no more text frames
  let finished = false; // finalized or ended: no `end` frame either
  let pending: string | undefined;
  let lastSent = "";
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const start = () => {
    if (started || finished) return;
    started = params.perform({ kind: "start", ...where });
  };

  const sendPending = () => {
    cancelTimer();
    const text = pending;
    pending = undefined;
    if (text === undefined || text === lastSent || !started || finished) return;
    if (params.perform({ kind: "text", ...where, text, seq: ++seq })) lastSent = text;
  };

  return {
    start,
    update: (text) => {
      if (closed) return;
      const snapshot = text.trimEnd();
      if (!snapshot) return;
      if (snapshot.length > maxChars) {
        // The final post still carries the full text.
        closed = true;
        pending = undefined;
        cancelTimer();
        return;
      }
      start();
      pending = snapshot;
      if (!timer) {
        timer = setTimeout(sendPending, throttleMs);
        timer.unref?.();
      }
    },
    flush: async () => sendPending(),
    id: () => (started ? draftId : undefined),
    seal: async () => {
      sendPending();
      closed = true;
    },
    discardPending: async () => {
      pending = undefined;
      cancelTimer();
    },
    clear: async () => {
      pending = undefined;
      cancelTimer();
      closed = true;
      if (started && !finished) params.perform({ kind: "end", ...where });
      finished = true;
      return true;
    },
    markFinalized: () => {
      pending = undefined;
      cancelTimer();
      closed = true;
      finished = true;
    },
  };
}
