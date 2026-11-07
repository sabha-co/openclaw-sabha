import { describe, expect, it } from "vitest";
import { createReplayPositions } from "./replay-positions.js";

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
});
