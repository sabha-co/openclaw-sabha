import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";

import { sabhaMessageActions } from "./message-actions.js";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function withMockedFetch(body: unknown = {}, location?: string) {
  const fetch = vi.fn(async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (location) headers.Location = location;
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as unknown as FetchMock;
  const original = globalThis.fetch;
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return {
    fetch,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function cfg(): OpenClawConfig {
  return {
    channels: {
      sabha: {
        accounts: {
          default: {
            baseUrl: "https://sabha.example",
            apiBaseUrl: "https://sabha.example/api/bots",
            botKey: "1-Key",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function ctx(action: string, params: Record<string, unknown>): ChannelMessageActionContext {
  return {
    channel: "sabha",
    action: action as ChannelMessageActionContext["action"],
    cfg: cfg(),
    params,
  } as ChannelMessageActionContext;
}

describe("sabhaMessageActions.handleAction", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("supportsAction returns true for declared actions, false otherwise", () => {
    const supports = sabhaMessageActions.supportsAction!;
    for (const a of [
      "send",
      "edit",
      "unsend",
      "react",
      "thread-reply",
      "search",
      "member-info",
    ]) {
      expect(
        supports({ action: a as ChannelMessageActionContext["action"] }),
      ).toBe(true);
    }
    // `reply` is intentionally NOT in the supported set — agents should use
    // `send` with replyToId or `thread-reply` (which fails closed when
    // messageId is missing).
    expect(supports({ action: "reply" as ChannelMessageActionContext["action"] })).toBe(false);
    expect(supports({ action: "kick" as ChannelMessageActionContext["action"] })).toBe(false);
  });

  it("send → POST /rooms/:to/messages", async () => {
    const mock = withMockedFetch({}, "/rooms/123/messages/456");
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("send", { to: 123, message: "hello" }),
    );

    expect(mock.fetch).toHaveBeenCalledOnce();
    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toBe("https://sabha.example/api/bots/rooms/123/messages");
    expect(mock.fetch.mock.calls[0][1]?.method).toBe("POST");
    expect((result.details as { messageId: number }).messageId).toBe(456);
  });

  it("send with replyToId → POST .../messages/:msg/thread", async () => {
    const mock = withMockedFetch({ thread: { id: 9 }, message: { id: 99 } });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("send", { to: 123, message: "hi", replyToId: 42 }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toBe("https://sabha.example/api/bots/rooms/123/messages/42/thread");
  });

  it("edit → PATCH .../messages/:msg", async () => {
    const mock = withMockedFetch({ id: 42, body: { html: "", plain: "" } });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("edit", { to: 123, messageId: 42, message: "fixed" }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe("https://sabha.example/api/bots/rooms/123/messages/42");
    expect(call[1]?.method).toBe("PATCH");
  });

  it("unsend → DELETE .../messages/:msg", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("unsend", { to: 123, messageId: 42 }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe("https://sabha.example/api/bots/rooms/123/messages/42");
    expect(call[1]?.method).toBe("DELETE");
  });

  it("react → POST .../boosts with emoji", async () => {
    const mock = withMockedFetch({ id: 7 });
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("react", { to: 123, messageId: 42, emoji: "👍" }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe(
      "https://sabha.example/api/bots/rooms/123/messages/42/boosts",
    );
    expect(call[1]?.method).toBe("POST");
    expect((result.details as { boostId: number }).boostId).toBe(7);
  });

  it("thread-reply → POST .../messages/:msg/thread", async () => {
    const mock = withMockedFetch({ thread: { id: 9 }, message: { id: 99 } });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("thread-reply", { to: 123, messageId: 42, message: "in thread" }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe(
      "https://sabha.example/api/bots/rooms/123/messages/42/thread",
    );
    expect(call[1]?.method).toBe("POST");
  });

  it("member-info → GET /users/:id and returns the rich profile", async () => {
    const mock = withMockedFetch(
      {
        id: 42,
        name: "Alice",
        role: "member",
        bot: false,
        url: "/u/42",
        bio: "Reads books",
        twitter_url: "https://x.com/alice",
        linkedin_url: null,
        personal_url: null,
      },
    );
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("member-info", { userId: 42 }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toBe("https://sabha.example/api/bots/users/42");
    const profile = (result.details as { profile: { id: number; bio: string | null } }).profile;
    expect(profile.id).toBe(42);
    expect(profile.bio).toBe("Reads books");
  });

  it("member-info throws when userId is missing", async () => {
    await expect(
      sabhaMessageActions.handleAction!(ctx("member-info", {})),
    ).rejects.toThrow(/userId/);
  });

  it("search → GET /search with query, returns results + hasMore + nextCursor", async () => {
    const mock = withMockedFetch({
      results: [{ id: 1 }, { id: 2 }],
      has_more: false,
      next_cursor: null,
    });
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("search", { query: "hello world" }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("/search?");
    // URLSearchParams encodes spaces as `+`, not `%20`.
    expect(url).toContain("query=hello+world");
    const details = result.details as {
      results: unknown[];
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(details.results).toHaveLength(2);
    expect(details.hasMore).toBe(false);
    expect(details.nextCursor).toBeNull();
  });

  it("search propagates roomIds and authorIds as repeated keys", async () => {
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", {
        query: "hi",
        roomIds: [1, 2, 3],
        authorIds: [42],
      }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    // Repeated-key array form (Rails default).
    expect(url).toContain("room_ids=1");
    expect(url).toContain("room_ids=2");
    expect(url).toContain("room_ids=3");
    expect(url).toContain("author_ids=42");
  });

  it("search accepts a CSV string for roomIds/authorIds (agent ergonomics)", async () => {
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", { query: "hi", room_ids: "1,2,3" }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("room_ids=1");
    expect(url).toContain("room_ids=2");
    expect(url).toContain("room_ids=3");
  });

  it("search accepts the canonical channelId / channelIds / authorId / authorIds shape", async () => {
    // Cross-channel callers (e.g. the cron message tool, an isolated
    // agent dispatch) use the SDK-canonical field names from core's
    // buildChannelTargetSchema. Sabha rooms are channels; without these
    // aliases, the scope would be silently dropped and run a
    // workspace-wide search.
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", {
        query: "hi",
        channelId: 7,
        channelIds: [8, 9],
        authorId: 42,
        authorIds: [99, 100],
      }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    // Plural keys come first (per readNumberList ordering), then the
    // singular gets appended.
    expect(url).toContain("room_ids=8");
    expect(url).toContain("room_ids=9");
    expect(url).toContain("room_ids=7");
    expect(url).toContain("author_ids=99");
    expect(url).toContain("author_ids=100");
    expect(url).toContain("author_ids=42");
  });

  it("search unions canonical and Sabha-native plurals (no double-counting on overlap)", async () => {
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", {
        query: "hi",
        channelIds: [1],
        roomIds: [2],
      }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("room_ids=1");
    expect(url).toContain("room_ids=2");
  });

  it("search silently drops non-numeric entries from a mixed array (lossy by design)", async () => {
    // Agents trained on REST APIs sometimes emit ["1", "abc", 2] when
    // they're unsure about the wire type. Rather than failing the
    // entire call (which would lose a recoverable query), we drop the
    // unparseable entries. Schema validation at the SDK boundary is
    // the proper place to reject — this test pins the lossy fallback
    // so a future stricter mode is an explicit choice, not an
    // accident.
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", { query: "hi", roomIds: [1, "abc", 2] }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("room_ids=1");
    expect(url).toContain("room_ids=2");
    expect(url).not.toContain("room_ids=abc");
  });

  it("search propagates before/after/limit/cursor", async () => {
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", {
        query: "hi",
        before: "2026-04-28T00:00:00Z",
        after: "2026-04-01T00:00:00Z",
        limit: 100,
        cursor: "2026-04-15T12:00:00Z|987",
      }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("before=2026-04-28T00%3A00%3A00Z");
    expect(url).toContain("after=2026-04-01T00%3A00%3A00Z");
    expect(url).toContain("limit=100");
    expect(url).toContain("cursor=2026-04-15T12%3A00%3A00Z%7C987");
  });

  it("search surfaces the hasMore + nextCursor signal back to the agent", async () => {
    const mock = withMockedFetch({
      results: [{ id: 1 }],
      has_more: true,
      next_cursor: "2026-04-15T12:00:00Z|987",
    });
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("search", { query: "hi" }),
    );

    const details = result.details as {
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(details.hasMore).toBe(true);
    expect(details.nextCursor).toBe("2026-04-15T12:00:00Z|987");
    expect(result.content[0].text).toMatch(/more available/);
  });

  it("throws when required params are missing", async () => {
    const handle = sabhaMessageActions.handleAction!;
    await expect(handle(ctx("send", { to: 1 }))).rejects.toThrow(/message/);
    await expect(handle(ctx("edit", { to: 1, messageId: 2 }))).rejects.toThrow(/message/);
    await expect(handle(ctx("react", { to: 1, messageId: 2 }))).rejects.toThrow(/emoji/);
    await expect(handle(ctx("search", {}))).rejects.toThrow(/query/);
    await expect(handle(ctx("send", { message: "hi" }))).rejects.toThrow(/room/);
  });
});
