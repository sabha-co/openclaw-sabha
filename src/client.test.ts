import { describe, it, expect, vi, afterEach } from "vitest";
import { SabhaClient, extractBotId } from "./client.js";
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
    messages_url: "https://chat.example.com/api/bots/rooms/5/messages",
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
    if (result.event === "message_created") {
      expect(result.user.name).toBe("Alice");
      expect(result.room.id).toBe(5);
      expect(result.message.id).toBe(10);
    }
  });

  it("rejects null", () => {
    expect(() => parseWebhookPayload(null)).toThrow("not an object");
  });

  it("rejects missing event", () => {
    expect(() => parseWebhookPayload({ user: {}, room: {}, message: {} })).toThrow("event");
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseWebhookPayload({
        event: "typing_started",
        user: basePayload.user,
        room: basePayload.room,
        message: basePayload.message,
      }),
    ).toThrow("Unknown event type");
  });

  it("accepts every message-bearing variant", () => {
    for (const event of [
      "message_created",
      "message_updated",
      "message_deleted",
    ] as const) {
      const p = parseWebhookPayload({ ...basePayload, event });
      expect(p.event).toBe(event);
    }
  });

  it("accepts boost_created and boost_deleted with a boost field", () => {
    for (const event of ["boost_created", "boost_deleted"] as const) {
      const p = parseWebhookPayload({
        ...basePayload,
        event,
        boost: { id: 99, body: "👍" },
      });
      expect(p.event).toBe(event);
      if (p.event === "boost_created" || p.event === "boost_deleted") {
        expect(p.boost.id).toBe(99);
      }
    }
  });

  it("rejects a boost event missing the boost field", () => {
    expect(() =>
      parseWebhookPayload({ ...basePayload, event: "boost_created" }),
    ).toThrow(/boost/);
  });

  it("accepts user_created with only {event, user} (no room / no message)", () => {
    const p = parseWebhookPayload({
      event: "user_created",
      user: basePayload.user,
    });
    expect(p.event).toBe("user_created");
  });

  it("accepts user_deleted with only {event, user}", () => {
    const p = parseWebhookPayload({
      event: "user_deleted",
      user: basePayload.user,
    });
    expect(p.event).toBe("user_deleted");
  });

  it("still requires room/message on message-bearing events", () => {
    expect(() =>
      parseWebhookPayload({
        event: "message_updated",
        user: basePayload.user,
      }),
    ).toThrow(/room/);
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

describe("SabhaClient — bearer auth + URL shape", () => {
  const API = "https://sabha.example.com/1000006/api/bots";
  const BOT_KEY = "42-AbCdEfGhIjKl";

  let restore: (() => void) | null = null;
  let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

  function mockFetch(
    build: (url: string) => Response | Promise<Response> = () =>
      new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Location: "/rooms/5/messages/123",
        },
      }),
  ) {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return build(String(input));
    }) as unknown as ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };
  }

  afterEach(() => {
    restore?.();
    restore = null;
  });

  function lastCall(): {
    url: string;
    init: RequestInit;
    auth: string | null;
  } {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const url = String(call[0]);
    const init = (call[1] ?? {}) as RequestInit;
    const headers =
      init.headers instanceof Headers
        ? init.headers
        : new Headers((init.headers ?? {}) as HeadersInit);
    return { url, init, auth: headers.get("Authorization") };
  }

  it("sends Authorization: Bearer <botKey> on every request", async () => {
    mockFetch();
    const client = new SabhaClient(API, BOT_KEY);

    await client.listRooms();
    expect(lastCall().auth).toBe(`Bearer ${BOT_KEY}`);

    await client.sendMessage(5, "hello");
    expect(lastCall().auth).toBe(`Bearer ${BOT_KEY}`);

    await client.editMessage(10, "hi").catch(() => {
      /* body parsing differs per-mock; auth assertion is what we care about */
    });
    expect(lastCall().auth).toBe(`Bearer ${BOT_KEY}`);

    await client.search("x").catch(() => {});
    expect(lastCall().auth).toBe(`Bearer ${BOT_KEY}`);

    await client.updateSettings({ name: "x" });
    expect(lastCall().auth).toBe(`Bearer ${BOT_KEY}`);

    // sendAttachment is the one body type where manual Content-Type
    // handling would show up as a silent 415 in production (FormData
    // needs `fetch` to auto-populate the multipart boundary).
    await client.sendAttachment(
      5,
      new Blob(["hello"], { type: "text/plain" }),
      "note.txt",
    );
    expect(lastCall().auth).toBe(`Bearer ${BOT_KEY}`);
  });

  it("never forces Content-Type on sendAttachment (FormData needs fetch-generated boundary)", async () => {
    mockFetch();
    const client = new SabhaClient(API, BOT_KEY);

    await client.sendAttachment(
      5,
      new Blob(["hello"], { type: "text/plain" }),
      "note.txt",
    );

    const call = lastCall();
    const headers =
      call.init.headers instanceof Headers
        ? call.init.headers
        : new Headers((call.init.headers ?? {}) as HeadersInit);
    // If the client set Content-Type explicitly, the undici/Node fetch
    // would skip the multipart/form-data boundary step and the server
    // would reject the upload. Authorization must be present, but
    // Content-Type must be left to fetch.
    expect(headers.get("Authorization")).toBe(`Bearer ${BOT_KEY}`);
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("never includes bot_key in the URL path", async () => {
    mockFetch();
    const client = new SabhaClient(API, BOT_KEY);

    const calls: string[] = [];
    for (const run of [
      () => client.listRooms(),
      () => client.sendMessage(5, "hi"),
      () =>
        client.sendAttachment(
          5,
          new Blob(["x"], { type: "text/plain" }),
          "x.txt",
        ),
      () => client.replyInThread(5, 10, "hi").catch(() => {}),
      () => client.addReaction(10, "👍").catch(() => {}),
      () => client.createDm([1, 2]).catch(() => {}),
      () => client.search("q").catch(() => {}),
      () => client.updateSettings({ name: "x" }),
    ]) {
      await run();
      calls.push(lastCall().url);
    }

    for (const url of calls) {
      expect(url).not.toContain(BOT_KEY);
      expect(url.startsWith(API)).toBe(true);
    }
  });

  describe("listRooms — pagination + filter params", () => {
    it("hits /rooms with no query string when called bare", async () => {
      mockFetch();
      const client = new SabhaClient(API, BOT_KEY);
      await client.listRooms();

      expect(lastCall().url).toBe(`${API}/rooms`);
    });

    it("propagates joinable, query, page, and per_page", async () => {
      mockFetch();
      const client = new SabhaClient(API, BOT_KEY);
      await client.listRooms({
        joinable: true,
        query: "general",
        page: 2,
        perPage: 50,
      });

      const url = lastCall().url;
      expect(url).toContain("joinable=true");
      expect(url).toContain("query=general");
      expect(url).toContain("page=2");
      expect(url).toContain("per_page=50");
    });

    it("omits joinable when not specified (the server default already returns all rooms)", async () => {
      mockFetch();
      const client = new SabhaClient(API, BOT_KEY);
      await client.listRooms({ query: "hi" });

      expect(lastCall().url).not.toContain("joinable=");
    });

    it("URL-encodes query values with special characters", async () => {
      mockFetch();
      const client = new SabhaClient(API, BOT_KEY);
      await client.listRooms({ query: "team alpha & beta" });

      const url = lastCall().url;
      // URLSearchParams encodes spaces as `+` and `&` as `%26`.
      expect(url).toMatch(/query=team\+alpha\+%26\+beta/);
    });
  });

  describe("search — envelope + array params", () => {
    function searchMockFetch(json: {
      results: { id: number }[];
      has_more: boolean;
      next_cursor: string | null;
    }) {
      mockFetch(
        () =>
          new Response(JSON.stringify(json), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
    }

    it("returns the camel-cased envelope { results, hasMore, nextCursor }", async () => {
      searchMockFetch({
        results: [{ id: 1 }, { id: 2 }],
        has_more: true,
        next_cursor: "2026-04-15T12:00:00Z|987",
      });
      const client = new SabhaClient(API, BOT_KEY);
      const out = await client.search({ query: "hi" });

      expect(out.results).toHaveLength(2);
      expect(out.hasMore).toBe(true);
      expect(out.nextCursor).toBe("2026-04-15T12:00:00Z|987");
    });

    it("emits room_ids/author_ids as repeated keys (Rails default)", async () => {
      searchMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.search({
        query: "hi",
        roomIds: [1, 2, 3],
        authorIds: [42, 99],
      });

      const url = lastCall().url;
      expect(url).toContain("room_ids=1");
      expect(url).toContain("room_ids=2");
      expect(url).toContain("room_ids=3");
      expect(url).toContain("author_ids=42");
      expect(url).toContain("author_ids=99");
    });

    it("threads query/before/after/limit through unchanged when no cursor is set", async () => {
      searchMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.search({
        query: "hi",
        before: "2026-04-28T00:00:00Z",
        after: "2026-04-01T00:00:00Z",
        limit: 100,
      });

      const url = lastCall().url;
      expect(url).toContain("query=hi");
      expect(url).toContain("before=2026-04-28T00%3A00%3A00Z");
      expect(url).toContain("after=2026-04-01T00%3A00%3A00Z");
      expect(url).toContain("limit=100");
    });

    it("cursor preempts before and rides on the wire's `before` URL param", async () => {
      // Regression for the latent cursor-mapping bug. The server's
      // CursorPaginated concern only reads params[:before]; it ignores
      // any `cursor=` URL param. Before the fix, `cursor` was sent as
      // `cursor=` and the server silently fell back to filter mode (or
      // re-fetched page 1 if no other filter was set).
      searchMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.search({
        query: "hi",
        before: "2026-04-28T00:00:00Z",
        cursor: "2026-04-15T12:00:00Z|987",
      });

      const url = lastCall().url;
      // Cursor wins over before — agent intent "continue paginating"
      // beats "filter older than X".
      expect(url).toContain("before=2026-04-15T12%3A00%3A00Z%7C987");
      // Original `before` value must NOT appear on the wire.
      expect(url).not.toContain("before=2026-04-28T00%3A00%3A00Z");
      // Server has no separate `cursor` URL param — it must not appear.
      expect(url).not.toContain("cursor=");
    });

    it("cursor-only call sends `before=<cursor>` (no separate `cursor=` URL param)", async () => {
      searchMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.search({
        query: "hi",
        cursor: "2026-04-15T12:00:00Z|987",
      });

      const url = lastCall().url;
      expect(url).toContain("before=2026-04-15T12%3A00%3A00Z%7C987");
      expect(url).not.toContain("cursor=");
    });

    it("omits empty arrays from the URL", async () => {
      searchMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.search({ query: "hi", roomIds: [], authorIds: [] });

      const url = lastCall().url;
      expect(url).not.toContain("room_ids=");
      expect(url).not.toContain("author_ids=");
    });

    it("a bare { query } produces exactly /search?query=<value> on the wire", async () => {
      // Pins the wire contract so a future change adding a default
      // limit / cursor would surface as a test failure rather than a
      // silent drift.
      searchMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.search({ query: "hi" });

      expect(lastCall().url).toBe(`${API}/search?query=hi`);
    });

    it("throws on a malformed envelope (defends against server regression to bare-array)", async () => {
      // Simulate the pre-envelope shape leaking back: bare array. Without
      // the runtime guard, this lands as `response.results.length` on
      // undefined at the agent path.
      mockFetch(
        () =>
          new Response(JSON.stringify([{ id: 1 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(client.search({ query: "hi" })).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it("treats missing next_cursor as null", async () => {
      mockFetch(
        () =>
          new Response(JSON.stringify({ results: [], has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new SabhaClient(API, BOT_KEY);
      const out = await client.search({ query: "hi" });

      expect(out.nextCursor).toBeNull();
    });
  });

  describe("readMessages — envelope + dual-purpose `before`", () => {
    function readMockFetch(json: {
      results: { id: number }[];
      has_more: boolean;
      next_cursor?: string | null;
    }) {
      mockFetch(
        () =>
          new Response(JSON.stringify(json), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
    }

    it("hits /rooms/:id/messages with no query string when no opts beyond roomId are passed", async () => {
      readMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.readMessages({ roomId: 5 });

      expect(lastCall().url).toBe(`${API}/rooms/5/messages`);
    });

    it("threads before/after/limit through to the wire", async () => {
      readMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.readMessages({
        roomId: 5,
        before: "2026-04-28T00:00:00Z",
        after: "2026-04-27T00:00:00Z",
        limit: 25,
      });

      const url = new URL(lastCall().url);
      expect(url.pathname).toBe("/1000006/api/bots/rooms/5/messages");
      expect(url.searchParams.get("before")).toBe("2026-04-28T00:00:00Z");
      expect(url.searchParams.get("after")).toBe("2026-04-27T00:00:00Z");
      expect(url.searchParams.get("limit")).toBe("25");
    });

    it("prefers cursor over before when both are passed (server has no separate `cursor` URL param)", async () => {
      readMockFetch({ results: [], has_more: false, next_cursor: null });
      const client = new SabhaClient(API, BOT_KEY);
      await client.readMessages({
        roomId: 5,
        before: "2026-04-28T00:00:00Z",
        cursor: "2026-04-20T00:00:00Z|999",
      });

      const url = new URL(lastCall().url);
      expect(url.searchParams.get("before")).toBe("2026-04-20T00:00:00Z|999");
      expect(url.searchParams.get("cursor")).toBeNull();
    });

    it("normalizes has_more / next_cursor to camelCase", async () => {
      readMockFetch({
        results: [{ id: 100 }],
        has_more: true,
        next_cursor: "2026-04-20T00:00:00Z|999",
      });
      const client = new SabhaClient(API, BOT_KEY);
      const out = await client.readMessages({ roomId: 5 });

      expect(out.hasMore).toBe(true);
      expect(out.nextCursor).toBe("2026-04-20T00:00:00Z|999");
      expect(out.results).toHaveLength(1);
    });

    it("treats missing next_cursor as null", async () => {
      readMockFetch({ results: [], has_more: false });
      const client = new SabhaClient(API, BOT_KEY);
      const out = await client.readMessages({ roomId: 5 });

      expect(out.nextCursor).toBeNull();
    });

    it("throws on bare-array response (envelope-guard regression)", async () => {
      mockFetch(
        () =>
          new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(client.readMessages({ roomId: 5 })).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it("throws on a non-object body (defends against a misconfigured proxy returning HTML)", async () => {
      mockFetch(
        () =>
          new Response(JSON.stringify("<html>oops</html>"), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(client.readMessages({ roomId: 5 })).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it("throws on a null body", async () => {
      mockFetch(
        () =>
          new Response("null", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(client.readMessages({ roomId: 5 })).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it("surfaces a 422 validation_failed body as SabhaApiError (malformed-cursor contract)", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({
              error: "'before' must be ISO8601 timestamp or composite cursor",
              code: "validation_failed",
            }),
            {
              status: 422,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(
        client.readMessages({ roomId: 5, cursor: "garbage" }),
      ).rejects.toMatchObject({
        name: "SabhaApiError",
        status: 422,
      });
    });
  });

  describe("listReactions", () => {
    it("hits /rooms/:id/messages/:msg/boosts", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ reactions: [], total: 0, truncated: false }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await client.listReactions(5, 100);

      expect(lastCall().url).toBe(`${API}/rooms/5/messages/100/boosts`);
    });

    it("returns the typed shape verbatim", async () => {
      const wire = {
        reactions: [
          {
            content: "🚀",
            count: 3,
            boosters: [
              { id: 1, name: "alice" },
              { id: 2, name: "bob" },
            ],
            truncated: false,
          },
        ],
        total: 3,
        truncated: false,
      };
      mockFetch(
        () =>
          new Response(JSON.stringify(wire), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const client = new SabhaClient(API, BOT_KEY);
      const out = await client.listReactions(5, 100);

      expect(out).toEqual(wire);
    });

    it("throws when `total` is missing (envelope-guard regression)", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ reactions: [], truncated: false }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(client.listReactions(5, 100)).rejects.toThrow(
        /unexpected shape/,
      );
    });

    it("surfaces a 404 as SabhaApiError (covers wrong room, missing message, and soft-deleted indistinguishably)", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({
              error: "Room or message not found",
              code: "not_found",
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      const client = new SabhaClient(API, BOT_KEY);
      await expect(client.listReactions(5, 100)).rejects.toMatchObject({
        name: "SabhaApiError",
        status: 404,
      });
    });
  });
});
