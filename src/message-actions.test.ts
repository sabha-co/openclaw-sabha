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
      "read",
      "reactions",
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

  it("send with replyToId → POST .../messages?parent_message_id (unified inline thread-reply)", async () => {
    const mock = withMockedFetch({ id: 99, room_id: 9 });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("send", { to: 123, message: "hi", replyToId: 42 }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toBe(
      "https://sabha.example/api/bots/rooms/123/messages?parent_message_id=42",
    );
  });

  it("edit → PATCH /messages/:msg (id-only path; server resolves the room)", async () => {
    const mock = withMockedFetch({ id: 42, body: { html: "", plain: "" } });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("edit", { to: 123, messageId: 42, message: "fixed" }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe("https://sabha.example/api/bots/messages/42");
    expect(call[1]?.method).toBe("PATCH");
  });

  it("unsend → DELETE /messages/:msg (id-only path)", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("unsend", { to: 123, messageId: 42 }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe("https://sabha.example/api/bots/messages/42");
    expect(call[1]?.method).toBe("DELETE");
  });

  it("react → POST /messages/:msg/boosts with emoji (id-only path)", async () => {
    const mock = withMockedFetch({ id: 7 });
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("react", { to: 123, messageId: 42, emoji: "👍" }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe(
      "https://sabha.example/api/bots/messages/42/boosts",
    );
    expect(call[1]?.method).toBe("POST");
    expect((result.details as { boostId: number }).boostId).toBe(7);
  });

  it("thread-reply → POST .../messages?parent_message_id (unified inline thread-reply)", async () => {
    const mock = withMockedFetch({ id: 99, room_id: 9 });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("thread-reply", { to: 123, messageId: 42, message: "in thread" }),
    );

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toBe(
      "https://sabha.example/api/bots/rooms/123/messages?parent_message_id=42",
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

  it("search propagates before/after/limit when no cursor is set", async () => {
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", {
        query: "hi",
        before: "2026-04-28T00:00:00Z",
        after: "2026-04-01T00:00:00Z",
        limit: 100,
      }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("before=2026-04-28T00%3A00%3A00Z");
    expect(url).toContain("after=2026-04-01T00%3A00%3A00Z");
    expect(url).toContain("limit=100");
  });

  it("search cursor preempts before and rides on the wire's `before` URL param", async () => {
    // The server's CursorPaginated concern only reads params[:before];
    // sending `cursor=` was a no-op (silently re-fetched page 1). Pinning
    // the corrected mapping here.
    const mock = withMockedFetch({ results: [], has_more: false, next_cursor: null });
    restore = mock.restore;

    await sabhaMessageActions.handleAction!(
      ctx("search", {
        query: "hi",
        before: "2026-04-28T00:00:00Z",
        cursor: "2026-04-15T12:00:00Z|987",
      }),
    );

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("before=2026-04-15T12%3A00%3A00Z%7C987");
    expect(url).not.toContain("before=2026-04-28T00%3A00%3A00Z");
    expect(url).not.toContain("cursor=");
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

  it("read → GET /rooms/:id/messages and projects results into the formatter-friendly `messages[]` shape", async () => {
    // The shared CLI formatter at `openclaw/src/commands/message-format.ts`
    // reads `payload.messages[]` (not `results`) and per-entry pulls
    // `timestamp` / `authorTag` / `text` — it doesn't know how to read
    // Sabha's raw `{ creator, body, created_at }` wire shape. This test
    // pins the projection so a future refactor that reverts to "verbatim"
    // breaks here instead of silently producing blank rows in
    // `openclaw message read --target sabha:...`.
    const mock = withMockedFetch({
      results: [
        {
          id: 100,
          creator: { id: 1, name: "alice" },
          body: { html: "<p>hi</p>", plain: "hi" },
          attachment: null,
          created_at: "2026-04-28T12:00:00Z",
        },
      ],
      has_more: true,
      next_cursor: "2026-04-28T12:00:00Z|100",
    });
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("read", { channelId: 5, limit: 25 }),
    );

    const url = new URL(String(mock.fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/bots/rooms/5/messages");
    expect(url.searchParams.get("limit")).toBe("25");
    const details = result.details as {
      messages: Array<{
        id: string;
        timestamp: string;
        author: { id: string; username: string };
        authorTag: string;
        text: string;
        attachment: unknown;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
      results?: unknown;
    };
    // Raw wire field must be gone — keeping both would let the LLM
    // accidentally consume the un-normalized one.
    expect(details.results).toBeUndefined();
    expect(details.messages).toHaveLength(1);
    const msg = details.messages[0];
    // Per-field projection: numeric ids are stringified (formatter's
    // `typeof === "string"` gate), `created_at` -> `timestamp`,
    // `creator.name` -> both `author.username` and `authorTag` so the
    // formatter's two-tier lookup (`authorTag` first, then
    // `author.username`) hits regardless of which it tries.
    expect(msg.id).toBe("100");
    expect(msg.timestamp).toBe("2026-04-28T12:00:00Z");
    expect(msg.authorTag).toBe("alice");
    expect(msg.author).toEqual({ id: "1", username: "alice" });
    expect(msg.text).toBe("hi");
    expect(msg.attachment).toBeNull();
    expect(details.hasMore).toBe(true);
    expect(details.nextCursor).toBe("2026-04-28T12:00:00Z|100");
    // Newest-first hint must land in the user-visible note text so the
    // agent learns the ordering from the first call without depending on
    // the system-prompt hint (which is gated behind availableTools).
    expect(result.content[0].text).toMatch(/newest first/);
    expect(result.content[0].text).toMatch(/cursor/);
  });

  it("read accepts every canonical room-target alias on the URL pathname", async () => {
    // Per-alias assertion — pinning each alias with a fresh mock so a
    // future change that drops an alias surfaces as a specific failure
    // rather than a general "no URL match" guess. The order matches
    // src/message-actions.ts's readNumber call.
    for (const key of [
      "channelId",
      "channel_id",
      "roomId",
      "room_id",
      "to",
      "target",
    ] as const) {
      const mock = withMockedFetch({
        results: [],
        has_more: false,
        next_cursor: null,
      });
      restore = mock.restore;
      await sabhaMessageActions.handleAction!(ctx("read", { [key]: 5 }));
      const url = new URL(String(mock.fetch.mock.calls[0][0]));
      expect(url.pathname).toBe("/api/bots/rooms/5/messages");
      restore();
      restore = null;
    }
  });

  it("read with cursor sends the cursor on `before=` and omits `cursor=`", async () => {
    const mock = withMockedFetch({
      results: [],
      has_more: false,
      next_cursor: null,
    });
    restore = mock.restore;
    await sabhaMessageActions.handleAction!(
      ctx("read", {
        channelId: 5,
        cursor: "2026-04-20T00:00:00Z|999",
        before: "2026-04-28T00:00:00Z",
      }),
    );
    const url = new URL(String(mock.fetch.mock.calls[0][0]));
    expect(url.searchParams.get("before")).toBe("2026-04-20T00:00:00Z|999");
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it("read rejects when no room target is provided", async () => {
    await expect(
      sabhaMessageActions.handleAction!(ctx("read", { limit: 10 })),
    ).rejects.toThrow(/single room target/);
  });

  it("reactions → GET /rooms/:id/messages/:msg/boosts and projects into the formatter-friendly `{name, users}` shape", async () => {
    // Same rationale as `read` above: the shared formatter reads
    // `entry.name` for the emoji label and `entry.users[].id` /
    // `entry.users[].username`, gating each on `typeof === "string"`.
    // Sabha's wire `{ content, boosters: [{id: number, name}] }` would
    // render as a blank-Emoji / blank-Users row without this projection.
    const wire = {
      reactions: [
        {
          content: "🚀",
          count: 3,
          boosters: [{ id: 1, name: "alice" }],
          truncated: false,
        },
      ],
      total: 3,
      truncated: false,
    };
    const mock = withMockedFetch(wire);
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("reactions", { channelId: 5, messageId: 100 }),
    );

    expect(String(mock.fetch.mock.calls[0][0])).toBe(
      "https://sabha.example/api/bots/rooms/5/messages/100/boosts",
    );
    const details = result.details as {
      reactions: Array<{
        name: string;
        count: number;
        users: Array<{ id: string; username: string }>;
        truncated: boolean;
      }>;
      total: number;
      truncated: boolean;
      // Raw wire fields must NOT be present — see read test above for
      // the "don't ship both" rationale.
      content?: unknown;
      boosters?: unknown;
    };
    expect(details).toEqual({
      reactions: [
        {
          name: "🚀",
          count: 3,
          users: [{ id: "1", username: "alice" }],
          truncated: false,
        },
      ],
      total: 3,
      truncated: false,
    });
    // Defensive: per-entry raw keys (`content`, `boosters`) must not leak
    // through. The structural deepEqual above already covers this, but
    // pin it explicitly so a future change that adds them back as
    // "extras" surfaces here.
    const entry = details.reactions[0] as Record<string, unknown>;
    expect(entry.content).toBeUndefined();
    expect(entry.boosters).toBeUndefined();
    expect(result.content[0].text).toMatch(/3 reaction/);
  });

  it("reactions empty case returns total: 0 with the matching note", async () => {
    const mock = withMockedFetch({
      reactions: [],
      total: 0,
      truncated: false,
    });
    restore = mock.restore;

    const result = await sabhaMessageActions.handleAction!(
      ctx("reactions", { channelId: 5, messageId: 100 }),
    );
    const details = result.details as { total: number; reactions: unknown[] };
    expect(details.total).toBe(0);
    expect(details.reactions).toEqual([]);
    expect(result.content[0].text).toMatch(/^No reactions/);
  });

  it("reactions throws the room-target error specifically when only messageId is given", async () => {
    // Tightened from the original `regex|regex` form so each missing-field
    // branch is pinned. The two `throw`s in dispatch (separate room and
    // messageId checks) make this test meaningful.
    await expect(
      sabhaMessageActions.handleAction!(ctx("reactions", { messageId: 100 })),
    ).rejects.toThrow(/single room target/);
  });

  it("reactions throws the messageId error specifically when only room is given", async () => {
    await expect(
      sabhaMessageActions.handleAction!(ctx("reactions", { channelId: 5 })),
    ).rejects.toThrow(/messageId/);
  });

  it("reactions surfaces a 404 as SabhaApiError (deleted vs missing indistinguishable)", async () => {
    const fetch = vi.fn(
      async () =>
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
    ) as unknown as FetchMock;
    const original = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    await expect(
      sabhaMessageActions.handleAction!(
        ctx("reactions", { channelId: 5, messageId: 100 }),
      ),
    ).rejects.toMatchObject({ name: "SabhaApiError", status: 404 });
  });
});
