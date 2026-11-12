import { describe, expect, it, vi } from "vitest";
import { createReplayPositions, type ReplayStore, type SavedReplay } from "./replay-positions.js";

const at = (offset: number, epoch = "e1") => ({ streamId: "app_events:508", epoch, offset });

describe("createReplayPositions", () => {
  it("advances only on commit, monotonically within an epoch", () => {
    const replay = createReplayPositions();
    replay.commit(at(4), 1);
    replay.commit(at(3), 1);
    expect(replay.positions.get("app_events:508")).toEqual({ epoch: "e1", offset: 4 });
    replay.commit(at(1, "e2"), 1);
    expect(replay.positions.get("app_events:508")).toEqual({ epoch: "e2", offset: 1 });
  });

  it("never moves past an event that failed to store on that connection", () => {
    const replay = createReplayPositions();
    replay.commit(at(4), 1);
    replay.freeze(at(5), 1); // offset 5 lost
    replay.commit(at(6), 1); // later frames on the same connection still store, but must not skip 5
    expect(replay.positions.get("app_events:508")).toEqual({ epoch: "e1", offset: 4 });
  });

  it("resumes advancing on a newer connection, which replays the gap", () => {
    const replay = createReplayPositions();
    replay.commit(at(4), 1);
    replay.freeze(at(5), 1);
    replay.commit(at(5), 2);
    replay.commit(at(6), 2);
    expect(replay.positions.get("app_events:508")).toEqual({ epoch: "e1", offset: 6 });
    replay.commit(at(9), 1); // a straggler from the failed connection is not trusted
    expect(replay.positions.get("app_events:508")).toEqual({ epoch: "e1", offset: 6 });
  });

  it("ignores frames without stream metadata", () => {
    const replay = createReplayPositions();
    replay.commit({}, 1);
    replay.freeze({}, 1);
    expect(replay.positions.size).toBe(0);
  });

  it("lets a restarted gateway resume where the last one stopped", async () => {
    const rows = new Map<string, SavedReplay>();
    const store: ReplayStore = { lookup: async (key) => rows.get(key), register: async (key, value) => void rows.set(key, value) };
    const first = createReplayPositions({ store, key: "default", onError: () => {} });
    expect(await first.restore()).toBeUndefined();
    first.connected();
    first.commit(at(4), 1);
    first.commit(at(5), 1);
    await first.flush();

    const second = createReplayPositions({ store, key: "default", onError: () => {} });
    const connectedAt = await second.restore();
    expect(second.positions.get("app_events:508")).toEqual({ epoch: "e1", offset: 5 });
    expect(connectedAt).toBeGreaterThan(Date.now() / 1000 - 5);
  });

  it("keeps working in memory when the store fails", async () => {
    const onError = vi.fn();
    const failing: ReplayStore = { lookup: async () => { throw new Error("locked"); }, register: async () => { throw new Error("locked"); } };
    const replay = createReplayPositions({ store: failing, key: "default", onError });
    expect(await replay.restore()).toBeUndefined();
    replay.commit(at(4), 1);
    await replay.flush();
    expect(replay.positions.get("app_events:508")).toEqual({ epoch: "e1", offset: 4 });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
