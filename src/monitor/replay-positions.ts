// Where to resume each AnyCable stream after a reconnect. A position advances
// only once its event is durably handled, so a history request never starts
// past an event that was lost. A failed store freezes its stream: later frames
// from that same connection may still be stored, but the position stays before
// the gap until a newer connection replays it (ingress ids make the replay
// idempotent).
//
// Positions are saved too, with the last moment the app was connected, so a
// restarted gateway asks for what arrived while it was down instead of
// starting from now.
import type { CableEventMeta, StreamPositions } from "./cable-socket.js";

export type SavedReplay = {
  positions: Record<string, { epoch: string; offset: number }>;
  /** Unix seconds: the last moment the app was known to be connected. */
  connectedAt: number;
};

export type ReplayStore = {
  lookup(key: string): Promise<SavedReplay | undefined>;
  register(key: string, value: SavedReplay): Promise<unknown>;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function createReplayPositions(saved: { store: ReplayStore; key: string; onError: (error: unknown) => void } | undefined = undefined) {
  const positions: StreamPositions = new Map();
  const frozenThrough = new Map<string, number>(); // stream -> last connection that failed to store on it
  let saving = Promise.resolve();
  let queued = false;

  // Coalesced: a burst of events makes one write, of the latest positions.
  const save = () => {
    if (!saved || queued) return;
    queued = true;
    saving = saving.then(async () => {
      queued = false;
      try {
        await saved.store.register(saved.key, { positions: Object.fromEntries(positions), connectedAt: nowSeconds() });
      } catch (error) {
        saved.onError(error);
      }
    });
  };

  return {
    /** Live map handed to `connectCable` for its history request. */
    positions,
    /** Loads what an earlier gateway saved, and returns when it was last connected. */
    async restore(): Promise<number | undefined> {
      if (!saved) return undefined;
      let last: SavedReplay | undefined;
      try {
        last = await saved.store.lookup(saved.key);
      } catch (error) {
        saved.onError(error);
      }
      for (const [streamId, position] of Object.entries(last?.positions ?? {})) {
        if (!positions.has(streamId)) positions.set(streamId, position);
      }
      return last?.connectedAt;
    },
    /** The app is connected at this moment. */
    connected: save,
    /** The event at `meta`, received on connection `from`, is durably handled. */
    commit(meta: CableEventMeta, from: number): void {
      if (!meta.streamId || !meta.epoch || typeof meta.offset !== "number") return;
      if (from <= (frozenThrough.get(meta.streamId) ?? 0)) return;
      const known = positions.get(meta.streamId);
      if (!known || known.epoch !== meta.epoch || meta.offset > known.offset) {
        positions.set(meta.streamId, { epoch: meta.epoch, offset: meta.offset });
        save();
      }
    },
    /** The event at `meta`, received on connection `from`, could not be stored. */
    freeze(meta: CableEventMeta, from: number): void {
      if (!meta.streamId) return;
      frozenThrough.set(meta.streamId, Math.max(from, frozenThrough.get(meta.streamId) ?? 0));
    },
    /** Settles pending saves, before the gateway stops. */
    flush: () => saving,
  };
}
