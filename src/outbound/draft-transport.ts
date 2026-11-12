// Live draft over AppEventsChannel `draft` frames (sabha-ai Part A).
//
// A draft is UI-only: Sabha broadcasts it to viewers and never stores it. The
// final reply posts with `client_message_id = draft id`, which gives the new
// message the draft's DOM id so it replaces the draft in place. That means no
// preview message ever exists: nothing to edit, delete or repair. `end` tears
// down a draft that produced no message.
//
// Older servers ignore the unknown `draft` action. One that also predates
// client_message_id refuses it by name, and the client then posts the final
// without it, as a normal message.
import { randomUUID } from "node:crypto";
import type { SabhaDraftFrame } from "../client/types.js";
import type { SabhaTarget } from "./send.js";

export const DRAFT_THROTTLE_MS = 250;
/** Matches the server's per-draft text cap; longer snapshots stop updating the draft. */
export const DRAFT_MAX_CHARS = 16_000;
/** A status line is one short line under the shell. */
export const DRAFT_ACTIVITY_MAX_CHARS = 120;

export type PerformDraft = (frame: SabhaDraftFrame) => boolean;

export type SabhaDraft = {
  /** Show the working shell now (before any text). */
  start: () => void;
  /** Full accumulated text snapshot; frames are coalesced to the throttle. */
  update: (text: string) => void;
  /**
   * What the agent is doing (a tool run), as the line under the shell. Opens
   * the shell if it isn't showing yet, so the first one replaces "Thinking…".
   * Returns whether the line went out.
   */
  activity: (title: string) => boolean;
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
  let lastActivity = "";
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
    activity: (title) => {
      const line = title.replace(/\s+/g, " ").trim().slice(0, DRAFT_ACTIVITY_MAX_CHARS);
      if (!line || finished) return false;
      start();
      if (!started) return false;
      if (line === lastActivity) return true;
      if (!params.perform({ kind: "activity", ...where, title: line, seq: ++seq })) return false;
      lastActivity = line;
      return true;
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
