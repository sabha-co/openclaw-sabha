import { afterEach, describe, expect, it, vi } from "vitest";
import type { SabhaDraftFrame } from "../client/types.js";
import { createSabhaDraft } from "./draft-transport.js";

afterEach(() => {
  vi.useRealTimers();
});

function draft(overrides: { connected?: boolean; maxChars?: number } = {}) {
  const frames: SabhaDraftFrame[] = [];
  const handle = createSabhaDraft({
    perform: (frame) => {
      if (overrides.connected === false) return false;
      frames.push(frame);
      return true;
    },
    target: { roomId: 3, parentMessageId: 4214 },
    throttleMs: 100,
    newId: () => "draft-1",
    ...(overrides.maxChars ? { maxChars: overrides.maxChars } : {}),
  });
  return { handle, frames };
}

describe("createSabhaDraft", () => {
  it("opens the shell on the first snapshot and coalesces text to the throttle", async () => {
    vi.useFakeTimers();
    const { handle, frames } = draft();
    handle.update("He");
    handle.update("Hello");
    handle.update("Hello wor");
    expect(frames).toEqual([{ kind: "start", draft_id: "draft-1", room_id: 3, parent_message_id: 4214 }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(frames[1]).toEqual({ kind: "text", draft_id: "draft-1", room_id: 3, parent_message_id: 4214, text: "Hello wor", seq: 1 });
    handle.update("Hello wor  ");
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(2);
    expect(handle.id()).toBe("draft-1");
  });

  it("ends a draft that produced no message, once", async () => {
    const { handle, frames } = draft();
    handle.start();
    await handle.clear();
    await handle.clear();
    expect(frames.map((frame) => frame.kind)).toEqual(["start", "end"]);
  });

  it("never ends a draft the final message replaced", async () => {
    const { handle, frames } = draft();
    handle.update("done");
    await handle.flush();
    handle.markFinalized();
    await handle.clear();
    expect(frames.map((frame) => frame.kind)).toEqual(["start", "text"]);
  });

  it("has no id while disconnected, so the final posts normally", () => {
    const { handle } = draft({ connected: false });
    handle.update("hi");
    expect(handle.id()).toBeUndefined();
  });

  it("stops updating past the size cap", async () => {
    const { handle, frames } = draft({ maxChars: 5 });
    handle.update("123456");
    await handle.flush();
    handle.update("1234567");
    await handle.flush();
    expect(frames).toEqual([]);
  });
});
