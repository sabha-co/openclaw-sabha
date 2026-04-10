import type { ConnectionRef } from "./monitor-websocket.js";

/**
 * Per-room typing state.
 *
 * `state` tracks the subscription lifecycle:
 *   - "pending"   — subscribe command sent, waiting for confirm_subscription
 *   - "ready"     — confirmation received, whispers will be delivered
 *   - (absent)    — not subscribed
 *
 * `refreshTimer` keeps Sabha's typing indicator alive (it fades after ~6s
 * without a refresh whisper). Only set while we want the indicator on.
 *
 * `pendingStart` is true if `start()` was called before the subscription
 * confirmed — the refresh timer fires that first whisper immediately on
 * confirmation.
 */
type RoomState = {
  subscription: "pending" | "ready";
  refreshTimer?: ReturnType<typeof setInterval>;
  pendingStart?: boolean;
};

/**
 * Sabha's browser typing indicator fades after ~6s, so refresh a bit before.
 */
const DEFAULT_REFRESH_MS = 4000;

export type TypingManagerOpts = {
  connectionRef: ConnectionRef;
  botId: number;
  botName: string;
  refreshMs?: number;
  logger?: { info?: (msg: string) => void; error?: (msg: string) => void };
};

function buildTypingIdentifier(roomId: number): string {
  return JSON.stringify({
    channel: "TypingNotificationsChannel",
    room_id: roomId,
  });
}

/**
 * Manages typing indicators via AnyCable's `whisper` command.
 *
 * Whispers bypass Rails RPC — AnyCable-Go routes them directly to other
 * subscribers of TypingNotificationsChannel. Matches Sabha's browser-side
 * typing controller (app/javascript/controllers/typing_notifications_controller.js).
 *
 * Lifecycle per room:
 *   1. start() — send subscribe command, mark pending, start refresh timer
 *   2. onSubscriptionConfirmed(identifier) — mark ready, flush pending start
 *   3. refresh timer fires every N ms while state === "ready"
 *   4. stop() — whisper stop, cancel refresh, forget state
 */
export class TypingManager {
  private readonly rooms = new Map<number, RoomState>();
  private readonly refreshMs: number;

  constructor(private readonly opts: TypingManagerOpts) {
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  }

  /**
   * Begin showing a typing indicator in the given room. Safe to call
   * repeatedly — subsequent calls reset the refresh timer.
   */
  start(roomId: number): void {
    if (!this.opts.connectionRef.sendFrame) {
      // Disconnected: no point subscribing or scheduling refreshes —
      // the frames would land on a dead socket.
      return;
    }

    let state = this.rooms.get(roomId);
    if (!state) {
      // First time for this room — send subscribe and mark pending.
      // The whisper will flush when onSubscriptionConfirmed fires.
      this.sendSubscribe(roomId);
      state = { subscription: "pending", pendingStart: true };
      this.rooms.set(roomId, state);
    } else {
      // Already subscribed (or pending) — flush start immediately if ready,
      // otherwise mark the flush as pending for when confirmation lands.
      if (state.subscription === "ready") {
        this.whisper(roomId, "start");
      } else {
        state.pendingStart = true;
      }
    }

    // Reset any existing refresh timer so we don't stack them up.
    if (state.refreshTimer) clearInterval(state.refreshTimer);

    state.refreshTimer = setInterval(() => {
      const current = this.rooms.get(roomId);
      if (current?.subscription === "ready") {
        this.whisper(roomId, "start");
      }
      // If still pending, the refresh is a no-op and we wait for confirm.
    }, this.refreshMs);
  }

  /**
   * Stop showing the typing indicator in the given room and cancel the
   * refresh timer. Safe to call even if start() wasn't.
   */
  stop(roomId: number): void {
    const state = this.rooms.get(roomId);
    if (!state) return;

    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = undefined;
    state.pendingStart = false;

    // Only whisper stop if the server has acknowledged our subscription —
    // sending a whisper before confirm_subscription is silently dropped.
    if (state.subscription === "ready") {
      this.whisper(roomId, "stop");
    }
  }

  /**
   * Called by the WebSocket layer when an auxiliary subscription is
   * confirmed. If we were waiting on this room, flush any pending start
   * whisper now that AnyCable will route it.
   */
  onSubscriptionConfirmed(identifier: string): void {
    const roomId = this.roomIdFromIdentifier(identifier);
    if (roomId == null) return;

    const state = this.rooms.get(roomId);
    if (!state) return;

    state.subscription = "ready";
    if (state.pendingStart) {
      state.pendingStart = false;
      this.whisper(roomId, "start");
    }
  }

  /**
   * Called by the WebSocket layer when an auxiliary subscription is
   * rejected. Sabha rejects subscribes to rooms the bot isn't a member
   * of (or that don't exist in the bot's tenant). Cancel the refresh
   * timer and forget the room so we don't leak a useless interval.
   */
  onSubscriptionRejected(identifier: string): void {
    const roomId = this.roomIdFromIdentifier(identifier);
    if (roomId == null) return;

    const state = this.rooms.get(roomId);
    if (!state) return;

    if (state.refreshTimer) clearInterval(state.refreshTimer);
    this.rooms.delete(roomId);
    this.opts.logger?.error?.(
      `[sabha] Typing subscription rejected for room ${roomId} — bot may not be a member`,
    );
  }

  /**
   * Reset local state after the WebSocket reconnects. The server forgot
   * all subscriptions, so the next start() must re-subscribe. No whispers
   * are sent — the old connection is gone and the server cleaned up on its
   * side. Also cancels all refresh timers.
   */
  reset(): void {
    for (const state of this.rooms.values()) {
      if (state.refreshTimer) clearInterval(state.refreshTimer);
    }
    this.rooms.clear();
  }

  /**
   * Currently-tracked room count (for tests and diagnostics).
   */
  size(): number {
    return this.rooms.size;
  }

  private sendSubscribe(roomId: number): void {
    const send = this.opts.connectionRef.sendFrame;
    if (!send) return;

    try {
      send(
        JSON.stringify({
          command: "subscribe",
          identifier: buildTypingIdentifier(roomId),
        }),
      );
    } catch (err) {
      this.opts.logger?.error?.(
        `[sabha] Typing subscribe failed for room ${roomId}: ${formatError(err)}`,
      );
    }
  }

  private whisper(roomId: number, action: "start" | "stop"): void {
    const send = this.opts.connectionRef.sendFrame;
    if (!send) return;

    try {
      send(
        JSON.stringify({
          command: "whisper",
          identifier: buildTypingIdentifier(roomId),
          data: {
            action,
            user: { id: this.opts.botId, name: this.opts.botName },
          },
        }),
      );
    } catch {
      // Typing is non-critical — swallow errors so they don't break the
      // main message dispatch flow.
    }
  }

  private roomIdFromIdentifier(identifier: string): number | null {
    try {
      const parsed = JSON.parse(identifier) as { channel?: string; room_id?: number };
      if (parsed.channel !== "TypingNotificationsChannel") return null;
      return typeof parsed.room_id === "number" ? parsed.room_id : null;
    } catch {
      return null;
    }
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
