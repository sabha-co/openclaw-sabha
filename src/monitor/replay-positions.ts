// Where to resume each AnyCable stream after a reconnect. A position advances
// only once its event is durably handled, so a history request never starts
// past an event that was lost. A failed store freezes its stream: later frames
// from that same connection may still be stored, but the position stays before
// the gap until a newer connection replays it (ingress ids make the replay
// idempotent).
import type { CableEventMeta, StreamPositions } from "./cable-socket.js";

export function createReplayPositions() {
  const positions: StreamPositions = new Map();
  const frozenThrough = new Map<string, number>(); // stream -> last connection that failed to store on it

  return {
    /** Live map handed to `connectCable` for its history request. */
    positions,
    /** The event at `meta`, received on connection `from`, is durably handled. */
    commit(meta: CableEventMeta, from: number): void {
      if (!meta.streamId || !meta.epoch || typeof meta.offset !== "number") return;
      if (from <= (frozenThrough.get(meta.streamId) ?? 0)) return;
      const known = positions.get(meta.streamId);
      if (!known || known.epoch !== meta.epoch || meta.offset > known.offset) {
        positions.set(meta.streamId, { epoch: meta.epoch, offset: meta.offset });
      }
    },
    /** The event at `meta`, received on connection `from`, could not be stored. */
    freeze(meta: CableEventMeta, from: number): void {
      if (!meta.streamId) return;
      frozenThrough.set(meta.streamId, Math.max(from, frozenThrough.get(meta.streamId) ?? 0));
    },
  };
}
