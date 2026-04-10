import { describe, it, expect } from "vitest";
import { extractBotId } from "./client.js";
import { parseWebhookPayload, wasBotMentioned, resolveChatType } from "./webhook.js";
import { resolveSessionFromPayload, resolveSessionConversation } from "./session.js";
import { parseJoinUrl } from "./setup-wizard.js";

describe("extractBotId", () => {
  it("extracts numeric ID from bot key", () => {
    expect(extractBotId("42-AbCdEfGhIjKl")).toBe(42);
  });

  it("extracts ID from longer keys", () => {
    expect(extractBotId("123-xyzabc123def")).toBe(123);
  });

  it("returns 0 for invalid key", () => {
    expect(extractBotId("invalid")).toBe(0);
    expect(extractBotId("")).toBe(0);
  });
});

const basePayload = {
  event: "message_created" as const,
  user: { id: 1, name: "Alice", role: "member", url: "https://chat.example.com/users/1" },
  room: {
    id: 5,
    name: "General",
    type: "Open",
    members: 12,
    has_bot: true,
    messages_url: "https://chat.example.com/rooms/5/42-AbCdEfGhIjKl/messages",
  },
  message: {
    id: 10,
    body: { html: "<p>Hello @MyBot</p>", plain: "Hello @MyBot" },
    has_attachment: false,
    attachment: null,
    mentionees: [{ id: 42, name: "MyBot" }],
    url: "https://chat.example.com/rooms/5@10",
    created_at: "2026-04-07T12:00:00Z",
    updated_at: "2026-04-07T12:00:00Z",
    thread: null,
  },
};

describe("parseWebhookPayload", () => {
  it("accepts a valid payload", () => {
    const result = parseWebhookPayload(basePayload);
    expect(result.event).toBe("message_created");
    expect(result.user.name).toBe("Alice");
    expect(result.room.id).toBe(5);
    expect(result.message.id).toBe(10);
  });

  it("rejects null", () => {
    expect(() => parseWebhookPayload(null)).toThrow("not an object");
  });

  it("rejects missing event", () => {
    expect(() => parseWebhookPayload({ user: {}, room: {}, message: {} })).toThrow("event");
  });
});

describe("wasBotMentioned", () => {
  it("returns true when bot is mentioned", () => {
    expect(wasBotMentioned(basePayload, 42)).toBe(true);
  });

  it("returns false when bot is not mentioned", () => {
    expect(wasBotMentioned(basePayload, 99)).toBe(false);
  });
});

describe("resolveChatType", () => {
  it("returns direct for Direct rooms", () => {
    expect(resolveChatType("Direct")).toBe("direct");
  });

  it("returns group for Open rooms", () => {
    expect(resolveChatType("Open")).toBe("group");
  });

  it("returns group for Closed rooms", () => {
    expect(resolveChatType("Closed")).toBe("group");
  });
});

describe("resolveSessionFromPayload", () => {
  it("resolves a group session for Open room", () => {
    const result = resolveSessionFromPayload(basePayload);
    expect(result.chatType).toBe("group");
    expect(result.conversationId).toBe("5");
    expect(result.threadId).toBeUndefined();
  });

  it("resolves a direct session for DM", () => {
    const dmPayload = {
      ...basePayload,
      room: { ...basePayload.room, type: "Direct" },
    };
    const result = resolveSessionFromPayload(dmPayload);
    expect(result.chatType).toBe("direct");
    expect(result.conversationId).toBe("5");
  });

  it("resolves thread context", () => {
    const threadPayload = {
      ...basePayload,
      message: {
        ...basePayload.message,
        thread: { id: 99, parent_message_id: 10 },
      },
    };
    const result = resolveSessionFromPayload(threadPayload);
    expect(result.threadId).toBe("99");
    expect(result.baseConversationId).toBe("5");
    expect(result.parentConversationCandidates).toEqual(["5"]);
  });
});

describe("resolveSessionConversation", () => {
  it("resolves simple conversation", () => {
    const result = resolveSessionConversation({ rawId: "5" });
    expect(result.id).toBe("5");
    expect(result.threadId).toBeUndefined();
  });

  it("resolves threaded conversation", () => {
    const result = resolveSessionConversation({ rawId: "5", threadId: "99" });
    expect(result.id).toBe("5");
    expect(result.threadId).toBe("99");
    expect(result.baseConversationId).toBe("5");
  });
});

describe("parseJoinUrl", () => {
  it("parses single-tenant join URL", () => {
    const result = parseJoinUrl("https://chat.example.com/join/mNrP-Nm5q-HCzw");
    expect(result).toEqual({
      baseUrl: "https://chat.example.com",
      joinCode: "mNrP-Nm5q-HCzw",
    });
  });

  it("parses multi-tenant join URL with workspace ID", () => {
    const result = parseJoinUrl("https://chat.example.com/1000006/join/mNrP-Nm5q-HCzw");
    expect(result).toEqual({
      baseUrl: "https://chat.example.com/1000006",
      joinCode: "mNrP-Nm5q-HCzw",
    });
  });

  it("parses sabha.co SaaS URL with workspace ID", () => {
    const result = parseJoinUrl("https://sabha.co/1000101/join/Ccnp-m7vD-L3aj");
    expect(result).toEqual({
      baseUrl: "https://sabha.co/1000101",
      joinCode: "Ccnp-m7vD-L3aj",
    });
  });

  it("parses demo.sabha.co single-tenant URL", () => {
    const result = parseJoinUrl("https://demo.sabha.co/join/K5QP-Ytaa-X5xW");
    expect(result).toEqual({
      baseUrl: "https://demo.sabha.co",
      joinCode: "K5QP-Ytaa-X5xW",
    });
  });

  it("parses localhost URL", () => {
    const result = parseJoinUrl("http://localhost:3000/1000006/join/mNrP-Nm5q-HCzw");
    expect(result).toEqual({
      baseUrl: "http://localhost:3000/1000006",
      joinCode: "mNrP-Nm5q-HCzw",
    });
  });

  it("returns null for non-join URL", () => {
    expect(parseJoinUrl("https://chat.example.com/rooms/5")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(parseJoinUrl("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJoinUrl("")).toBeNull();
  });
});
