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
    const statuses: unknown[] = [];

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
      statusSink: (status) => statuses.push(status),
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
    emit("close", 1000, Buffer.from(""));
    expect(statuses.at(-1)).toMatchObject({ lifecycle: "blocked", connected: false });
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

    expect(statuses).toContainEqual(expect.objectContaining({ connected: true, lifecycle: "ready" }));

    emit("close", 1000, Buffer.from(""));
    await done;

    expect(statuses).toContainEqual(expect.objectContaining({ connected: false, lifecycle: "recovering" }));
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

  it("rejects on BotEventsChannel subscription rejection (fatal error)", async () => {
    const { ws, emit } = createMockWebSocket();
    const botEventsIdentifier = JSON.stringify({ channel: "BotEventsChannel" });

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));
    emit("message", JSON.stringify({
      type: "reject_subscription",
      identifier: botEventsIdentifier,
    }));

    expect(ws.close).toHaveBeenCalled();

    emit("close", 1000, Buffer.from(""));
    await expect(done).rejects.toThrow(SubscriptionRejectedError);
  });

  it("ignores reject_subscription for auxiliary channels (non-fatal)", async () => {
    const { ws, emit } = createMockWebSocket();
    const errors: string[] = [];
    const rejected: string[] = [];

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
      logger: {
        info: () => {},
        error: (msg) => errors.push(msg),
      },
      onAuxSubscriptionRejected: (id) => rejected.push(id),
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));
    const typingIdentifier = JSON.stringify({
      channel: "TypingNotificationsChannel",
      room_id: 5,
    });
    // Auxiliary channel rejection — should log but not close
    emit("message", JSON.stringify({
      type: "reject_subscription",
      identifier: typingIdentifier,
    }));

    // Connection stays open
    expect(ws.close).not.toHaveBeenCalled();
    expect(errors.some((e) => e.includes("Auxiliary subscription rejected"))).toBe(true);
    expect(rejected).toEqual([typingIdentifier]);

    emit("close", 1000, Buffer.from(""));
    await done;
  });

  it("does not forward data messages from auxiliary channels to onMessage", async () => {
    const { ws, emit } = createMockWebSocket();
    const messages: unknown[] = [];
    const botEventsIdentifier = JSON.stringify({ channel: "BotEventsChannel" });
    const typingIdentifier = JSON.stringify({
      channel: "TypingNotificationsChannel",
      room_id: 5,
    });

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: async (payload) => {
        messages.push(payload);
      },
      webSocketFactory: () => ws,
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));

    // Another user's typing whisper lands on our socket after we subscribed —
    // it must NOT reach the webhook parser.
    emit("message", JSON.stringify({
      identifier: typingIdentifier,
      message: { action: "start", user: { id: 99, name: "Alice" } },
    }));
    expect(messages).toHaveLength(0);

    // A real BotEventsChannel payload DOES reach onMessage.
    const botEventsPayload = { event: "message_created", user: {}, room: {}, message: {} };
    emit("message", JSON.stringify({
      identifier: botEventsIdentifier,
      message: botEventsPayload,
    }));
    expect(messages).toEqual([botEventsPayload]);

    emit("close", 1000, Buffer.from(""));
    await done;
  });

  it("only calls onBotEventsSubscribed for BotEventsChannel confirmation", async () => {
    const { ws, emit } = createMockWebSocket();
    const botEventsIdentifier = JSON.stringify({ channel: "BotEventsChannel" });
    const typingIdentifier = JSON.stringify({ channel: "TypingNotificationsChannel", room_id: 5 });

    const botEventsConfirms: number[] = [];
    const auxConfirms: string[] = [];

    const connectOnce = createSabhaConnectOnce({
      wsUrl: "ws://localhost/cable",
      onMessage: noopMessage(),
      webSocketFactory: () => ws,
      onBotEventsSubscribed: () => botEventsConfirms.push(1),
      onAuxSubscriptionConfirmed: (id) => auxConfirms.push(id),
    });

    const done = connectOnce();
    emit("open");
    emit("message", JSON.stringify({ type: "welcome" }));

    // BotEventsChannel confirmation
    emit("message", JSON.stringify({
      type: "confirm_subscription",
      identifier: botEventsIdentifier,
    }));
    expect(botEventsConfirms).toHaveLength(1);
    expect(auxConfirms).toHaveLength(0);

    // Auxiliary (typing) channel confirmation
    emit("message", JSON.stringify({
      type: "confirm_subscription",
      identifier: typingIdentifier,
    }));
    expect(botEventsConfirms).toHaveLength(1); // unchanged
    expect(auxConfirms).toEqual([typingIdentifier]);

    emit("close", 1000, Buffer.from(""));
    await done;
  });
});
