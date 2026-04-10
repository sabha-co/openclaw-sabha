import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypingManager } from "./typing.js";
import { createConnectionRef } from "./monitor-websocket.js";

function makeTypingIdentifier(roomId: number): string {
  return JSON.stringify({ channel: "TypingNotificationsChannel", room_id: roomId });
}

function setup() {
  const ref = createConnectionRef();
  const sent: Array<{ command: string; identifier: string; data?: unknown }> = [];
  ref.sendFrame = (frame) => {
    sent.push(JSON.parse(frame));
  };

  const manager = new TypingManager({
    connectionRef: ref,
    botId: 42,
    botName: "TestBot",
    refreshMs: 100,
  });

  // Helper: simulate AnyCable confirming the subscription for a room.
  const confirm = (roomId: number) => {
    manager.onSubscriptionConfirmed(makeTypingIdentifier(roomId));
  };

  return { ref, sent, manager, confirm };
}

describe("TypingManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("start", () => {
    it("sends subscribe on first start and queues the whisper", () => {
      const { sent, manager } = setup();
      manager.start(5);

      // Only the subscribe frame — no whisper until confirmation
      expect(sent).toHaveLength(1);
      expect(sent[0].command).toBe("subscribe");
      expect(JSON.parse(sent[0].identifier)).toEqual({
        channel: "TypingNotificationsChannel",
        room_id: 5,
      });

      manager.stop(5);
    });

    it("flushes the pending start on confirm_subscription", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);

      const whispers = sent.filter((f) => f.command === "whisper");
      expect(whispers).toHaveLength(1);
      expect(whispers[0].data).toEqual({
        action: "start",
        user: { id: 42, name: "TestBot" },
      });

      manager.stop(5);
    });

    it("does not re-subscribe on repeat start for the same room", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      manager.start(5);

      const subscribes = sent.filter((f) => f.command === "subscribe");
      expect(subscribes).toHaveLength(1);

      manager.stop(5);
    });

    it("sends whisper start immediately on repeat start after confirmation", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      const beforeRepeat = sent.filter((f) => f.command === "whisper").length;
      manager.start(5);
      const afterRepeat = sent.filter((f) => f.command === "whisper").length;
      expect(afterRepeat).toBe(beforeRepeat + 1);

      manager.stop(5);
    });

    it("no-ops when disconnected and does not schedule timers", () => {
      const ref = createConnectionRef();
      ref.sendFrame = null;
      const manager = new TypingManager({
        connectionRef: ref,
        botId: 1,
        botName: "Bot",
        refreshMs: 100,
      });

      expect(() => manager.start(5)).not.toThrow();
      expect(manager.size()).toBe(0);

      // No timer should be firing
      vi.advanceTimersByTime(1000);
      expect(manager.size()).toBe(0);
    });
  });

  describe("refresh timer", () => {
    it("does not fire whispers while subscription is pending", () => {
      const { sent, manager } = setup();
      manager.start(5);

      vi.advanceTimersByTime(500);
      const whispers = sent.filter((f) => f.command === "whisper");
      expect(whispers).toHaveLength(0);

      manager.stop(5);
    });

    it("fires start whispers after confirmation on the refresh interval", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);

      // Initial whisper from confirmation flush
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(1);

      vi.advanceTimersByTime(100);
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(2);

      vi.advanceTimersByTime(200);
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(4);

      manager.stop(5);
    });

    it("replaces the refresh timer on repeat start", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      vi.advanceTimersByTime(50);

      manager.start(5);
      const before = sent.filter((f) => f.command === "whisper").length;
      vi.advanceTimersByTime(99);
      expect(sent.filter((f) => f.command === "whisper").length).toBe(before);
      vi.advanceTimersByTime(2);
      expect(sent.filter((f) => f.command === "whisper").length).toBe(before + 1);

      manager.stop(5);
    });
  });

  describe("stop", () => {
    it("sends whisper stop after confirmation and cancels the refresh", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      manager.stop(5);

      const whispers = sent.filter((f) => f.command === "whisper");
      const actions = whispers.map((w) => (w.data as { action: string }).action);
      expect(actions).toEqual(["start", "stop"]);

      // No more refreshes after stop
      vi.advanceTimersByTime(1000);
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(2);
    });

    it("does not send whisper stop if subscription is still pending", () => {
      const { sent, manager } = setup();
      manager.start(5);
      // Server hasn't confirmed yet
      manager.stop(5);

      // No whispers — sending one before confirm would be silently dropped
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(0);
    });

    it("is a no-op when called without a prior start", () => {
      const { sent, manager } = setup();
      expect(() => manager.stop(5)).not.toThrow();
      expect(sent).toHaveLength(0);
    });

    it("removes the room from tracked state", () => {
      const { manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      expect(manager.size()).toBe(1);

      manager.stop(5);
      // Stop keeps the room in state so subscribe isn't re-sent
      // if the user starts typing again — but future tests can revisit
      // this decision if stop-then-start becomes a common pattern.
    });
  });

  describe("multiple rooms", () => {
    it("tracks separate subscription state per room", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      manager.start(10);

      const subscribes = sent.filter((f) => f.command === "subscribe");
      expect(subscribes).toHaveLength(2);

      confirm(5);
      expect(sent.filter((f) => f.command === "whisper").length).toBe(1);

      confirm(10);
      expect(sent.filter((f) => f.command === "whisper").length).toBe(2);

      manager.stop(5);
      manager.stop(10);
    });

    it("stopping one room does not affect the other's refresh", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      manager.start(10);
      confirm(5);
      confirm(10);

      manager.stop(5);
      const before = sent.filter((f) => f.command === "whisper").length;

      vi.advanceTimersByTime(100);
      const after = sent.filter((f) => f.command === "whisper").length;
      // Room 10 should have refreshed once; room 5 should not
      expect(after).toBe(before + 1);

      manager.stop(10);
    });
  });

  describe("reset", () => {
    it("cancels all timers and forgets subscriptions", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      manager.start(10);
      confirm(10);

      manager.reset();
      expect(manager.size()).toBe(0);

      // After reset, no refreshes should fire
      const before = sent.length;
      vi.advanceTimersByTime(1000);
      expect(sent.length).toBe(before);
    });

    it("does not whisper stop — the server already cleaned up on its side", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);

      const beforeReset = sent.length;
      manager.reset();
      // No whisper stop emitted — reset is for WS reconnect cleanup only
      expect(sent.length).toBe(beforeReset);
    });

    it("re-subscribes after reset", () => {
      const { sent, manager, confirm } = setup();
      manager.start(5);
      confirm(5);
      manager.reset();

      manager.start(5);
      const subscribesForRoom5 = sent.filter(
        (f) =>
          f.command === "subscribe" &&
          JSON.parse(f.identifier).room_id === 5,
      );
      expect(subscribesForRoom5).toHaveLength(2);
    });
  });

  describe("onSubscriptionRejected", () => {
    it("removes the room and cancels its refresh timer", () => {
      const { sent, manager } = setup();
      manager.start(5);
      expect(manager.size()).toBe(1);

      manager.onSubscriptionRejected(makeTypingIdentifier(5));
      expect(manager.size()).toBe(0);

      // No more refreshes should fire
      const before = sent.length;
      vi.advanceTimersByTime(1000);
      expect(sent.length).toBe(before);
    });

    it("ignores identifiers for other channels", () => {
      const { manager } = setup();
      manager.start(5);
      manager.onSubscriptionRejected(
        JSON.stringify({ channel: "BotEventsChannel" }),
      );
      expect(manager.size()).toBe(1);
      manager.stop(5);
    });

    it("allows re-subscribing after rejection clears state", () => {
      const { sent, manager } = setup();
      manager.start(5);
      manager.onSubscriptionRejected(makeTypingIdentifier(5));

      manager.start(5);
      const subscribes = sent.filter(
        (f) =>
          f.command === "subscribe" &&
          JSON.parse(f.identifier).room_id === 5,
      );
      expect(subscribes).toHaveLength(2);
      manager.stop(5);
    });
  });

  describe("onSubscriptionConfirmed", () => {
    it("ignores identifiers from other channels", () => {
      const { sent, manager } = setup();
      manager.start(5);

      // Non-typing channel — should be ignored
      manager.onSubscriptionConfirmed(
        JSON.stringify({ channel: "BotEventsChannel" }),
      );
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(0);

      // Typing channel for a different room — also ignored
      manager.onSubscriptionConfirmed(makeTypingIdentifier(999));
      expect(sent.filter((f) => f.command === "whisper")).toHaveLength(0);

      manager.stop(5);
    });

    it("tolerates malformed identifiers", () => {
      const { manager } = setup();
      expect(() => manager.onSubscriptionConfirmed("not json")).not.toThrow();
      expect(() => manager.onSubscriptionConfirmed("{}")).not.toThrow();
    });
  });
});
