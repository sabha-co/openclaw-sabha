import { describe, it, expect, vi } from "vitest";
import {
  createSabhaConnectOnce,
  DisconnectNoReconnectError,
  SubscriptionRejectedError,
  type WebSocketLike,
} from "./monitor-websocket.js";

type Listener = (...args: unknown[]) => void | Promise<void>;

function createMockWebSocket() {
  const listeners = new Map<string, Listener[]>();
  const sent: string[] = [];

  const ws: WebSocketLike = {
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    },
    send(data: string) {
      sent.push(data);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };

  function emit(event: string, ...args: unknown[]) {
    for (const l of listeners.get(event) ?? []) {
      l(...args);
    }
  }

  return { ws, emit, sent };
}

function noopMessage() {
  return async () => {};
}

describe("createSabhaConnectOnce", () => {
  it("follows welcome → subscribe → confirm → message flow", async () => {
    const { ws, emit, sent } = createMockWebSocket();
    const messages: unknown[] = [];

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable?bot_key=42-abc",
      onMessage: async (payload) => { messages.push(payload); },
      webSocketFactory: () => ws,
    });

    const done = connectOnce();

    // Simulate ActionCable protocol
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));

    // Should have sent subscribe command
    expect(sent).toHaveLength(1);
    const sub = JSON.parse(sent[0]);
    expect(sub.command).toBe("subscribe");
    expect(JSON.parse(sub.identifier).channel).toBe("BotEventsChannel");

    // Confirm subscription
    emit("message", JSON.stringify({
      type: "confirm_subscription",
      identifier: sub.identifier,
    }));

    // Send a message event
    const payload = {
      event: "message_created",
      user: { id: 1, name: "Alice" },
      room: { id: 5, name: "General" },
      message: { id: 10, body: { plain: "Hello" } },
    };
    emit("message", JSON.stringify({
      identifier: sub.identifier,
      message: payload,
    }));

    // Wait for async handler
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toEqual(payload);

    // Close cleanly
    emit("close", 1000, Buffer.from(""));
    await done;
  });

  it("ignores ping messages", async () => {
    const { ws, emit } = createMockWebSocket();
    const messages: unknown[] = [];

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: async (p) => { messages.push(p); },
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));
    emit("message", JSON.stringify({ type: "ping", message: 1234567890 }));

    expect(messages).toHaveLength(0);

    emit("close", 1000, Buffer.from(""));
    await done;
  });

  it("rejects on disconnect with reconnect: false", async () => {
    const { ws, emit } = createMockWebSocket();

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));
    emit("message", JSON.stringify({
      type: "disconnect",
      reason: "unauthorized",
      reconnect: false,
    }));

    await expect(done).rejects.toThrow(DisconnectNoReconnectError);
  });

  it("resolves on disconnect with reconnect: true", async () => {
    const { ws, emit } = createMockWebSocket();

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({
      type: "disconnect",
      reason: "server_restart",
      reconnect: true,
    }));
    emit("close", 1000, Buffer.from(""));

    // Should resolve (not reject)
    await done;
  });

  it("handles malformed messages without crashing", async () => {
    const { ws, emit } = createMockWebSocket();

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", "not json at all {{{");
    emit("message", JSON.stringify({ unexpected: "shape" }));
    emit("message", "");

    emit("close", 1000, Buffer.from(""));
    await done;
  });

  it("reports status via statusSink", async () => {
    const { ws, emit, sent } = createMockWebSocket();
    const statuses: unknown[] = [];

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
      statusSink: (patch) => statuses.push(patch),
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));
    emit("message", JSON.stringify({
      type: "confirm_subscription",
      identifier: JSON.parse(sent[0]).identifier,
    }));

    expect(statuses).toContainEqual(expect.objectContaining({ connected: true }));

    emit("close", 1000, Buffer.from(""));
    await done;

    expect(statuses).toContainEqual(expect.objectContaining({ connected: false }));
  });

  it("terminates on abort signal", async () => {
    const { ws, emit } = createMockWebSocket();
    const abort = new AbortController();

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
      abortSignal: abort.signal,
    });

    const done = connectOnce();
    emit("open");

    abort.abort();
    expect(ws.terminate).toHaveBeenCalled();

    emit("close", 1006, Buffer.from(""));
    await done;
  });

  it("rejects on subscription rejection (fatal error)", async () => {
    const { ws, emit } = createMockWebSocket();

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));
    emit("message", JSON.stringify({ type: "reject_subscription", identifier: "{}" }));

    expect(ws.close).toHaveBeenCalled();

    emit("close", 1000, Buffer.from(""));
    await expect(done).rejects.toThrow(SubscriptionRejectedError);
  });
});
