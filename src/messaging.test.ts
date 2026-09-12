import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  buildSabhaThreadingToolContext,
  inferSabhaTargetChatType,
  looksLikeSabhaTargetId,
  normalizeSabhaMessagingTarget,
  resolveSabhaDeliveryTarget,
  resolveSabhaMessagingTarget,
} from "./messaging.js";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function withMockedFetch(
  responder: (url: string) => { body: unknown; status?: number },
) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = responder(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
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

function basicCfg(): OpenClawConfig {
  return {
    channels: {
      sabha: {
        accounts: {
          a: {
            apiBaseUrl: "https://sabha.example/api/bots",
            botKey: "1-A",
          },
        },
        defaultAccount: "a",
      },
    },
  } as unknown as OpenClawConfig;
}

describe("normalizeSabhaMessagingTarget", () => {
  it("passes a bare numeric room id through unchanged", () => {
    expect(normalizeSabhaMessagingTarget("21")).toBe("21");
  });

  it("strips a leading `sabha:` provider prefix (case-insensitive)", () => {
    expect(normalizeSabhaMessagingTarget("sabha:21")).toBe("21");
    expect(normalizeSabhaMessagingTarget("SABHA:42")).toBe("42");
  });

  it("canonicalizes the `@{N}` mention form to `user:N`", () => {
    expect(normalizeSabhaMessagingTarget("@{42}")).toBe("user:42");
  });

  it("canonicalizes `sabha:@{N}` to `user:N`", () => {
    expect(normalizeSabhaMessagingTarget("sabha:@{42}")).toBe("user:42");
  });

  it("preserves explicit `user:` and `channel:` prefixes on numeric ids", () => {
    expect(normalizeSabhaMessagingTarget("user:42")).toBe("user:42");
    expect(normalizeSabhaMessagingTarget("channel:21")).toBe("channel:21");
  });

  it("folds `group:` into `channel:` (same kind in the runner)", () => {
    expect(normalizeSabhaMessagingTarget("group:21")).toBe("channel:21");
  });

  it("preserves explicit kind prefixes on names", () => {
    expect(normalizeSabhaMessagingTarget("user:alice")).toBe("user:alice");
    expect(normalizeSabhaMessagingTarget("channel:general")).toBe(
      "channel:general",
    );
  });

  it("strips a `sabha:` prefix that wraps a kind prefix", () => {
    expect(normalizeSabhaMessagingTarget("sabha:user:42")).toBe("user:42");
    expect(normalizeSabhaMessagingTarget("sabha:channel:21")).toBe(
      "channel:21",
    );
  });

  it("unwraps an inner `@{N}` after a kind prefix", () => {
    expect(normalizeSabhaMessagingTarget("user:@{42}")).toBe("user:42");
  });

  it("converts the `@<name>` sigil shorthand to `user:<name>`", () => {
    expect(normalizeSabhaMessagingTarget("@alex")).toBe("user:alex");
  });

  it("converts the `#<name>` sigil shorthand to `channel:<name>`", () => {
    expect(normalizeSabhaMessagingTarget("#general")).toBe("channel:general");
  });

  it("returns undefined for empty / whitespace-only / bare-prefix input", () => {
    expect(normalizeSabhaMessagingTarget("")).toBeUndefined();
    expect(normalizeSabhaMessagingTarget("   ")).toBeUndefined();
    expect(normalizeSabhaMessagingTarget("sabha:")).toBeUndefined();
    expect(normalizeSabhaMessagingTarget("user:")).toBeUndefined();
    expect(normalizeSabhaMessagingTarget("@")).toBeUndefined();
  });

  it("passes a bare name through unchanged so the resolver can query it", () => {
    expect(normalizeSabhaMessagingTarget("general")).toBe("general");
  });
});

describe("looksLikeSabhaTargetId", () => {
  it("recognizes a bare 2-digit room id (the `21` regression case)", () => {
    // The SDK default rejects bare digits under 6 chars (`^\+?\d{6,}$`).
    // Without this override, the runner falls through to a name-based
    // directory lookup that misses, and the runner emits
    // `Unknown target "21" for Sabha.`
    expect(looksLikeSabhaTargetId("21")).toBe(true);
  });

  it("recognizes the canonical `user:<digits>` and `channel:<digits>` forms", () => {
    expect(looksLikeSabhaTargetId("user:42", "user:42")).toBe(true);
    expect(looksLikeSabhaTargetId("channel:21", "channel:21")).toBe(true);
  });

  it("recognizes `user:`/`channel:`/`group:` numeric forms before normalize", () => {
    // Defense for call sites that hand looksLikeId the raw form without
    // running normalize first. Mirrors the SDK default's prefix-based
    // accept so explicit prefix forms keep the id-like fast path.
    expect(looksLikeSabhaTargetId("user:42")).toBe(true);
    expect(looksLikeSabhaTargetId("channel:21")).toBe(true);
    expect(looksLikeSabhaTargetId("group:21")).toBe(true);
  });

  it("recognizes the `@{N}` mention form on either raw or normalized", () => {
    expect(looksLikeSabhaTargetId("@{42}")).toBe(true);
    expect(looksLikeSabhaTargetId("ignored", "@{42}")).toBe(true);
  });

  it("treats `sabha:21` as id-like via the normalized form", () => {
    expect(looksLikeSabhaTargetId("sabha:21", "21")).toBe(true);
  });

  it("rejects bare names so they take the directory lookup path", () => {
    // Critical: if looksLikeId returned true for names, the runner would
    // fall back to `to: <normalized>` (non-numeric) when our resolveTarget
    // miss-resolves a name, and downstream Sabha action handlers would
    // receive a non-numeric `to:` that is not a valid room/user id.
    expect(looksLikeSabhaTargetId("general")).toBe(false);
    expect(looksLikeSabhaTargetId("user:alice", "user:alice")).toBe(false);
    expect(looksLikeSabhaTargetId("channel:general", "channel:general")).toBe(
      false,
    );
  });

  it("rejects empty input", () => {
    expect(looksLikeSabhaTargetId("")).toBe(false);
    expect(looksLikeSabhaTargetId("", "")).toBe(false);
  });
});

describe("resolveSabhaMessagingTarget", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("resolves a bare numeric id as a normalized group target without a server call", async () => {
    const mock = withMockedFetch(() => {
      throw new Error("no server call expected for bare numeric id");
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "21",
      normalized: "21",
    });

    expect(out).toEqual({
      to: "21",
      kind: "group",
      display: undefined,
      source: "normalized",
    });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("resolves `user:42` to a user target without a server call", async () => {
    const mock = withMockedFetch(() => {
      throw new Error("no server call expected for explicit user:<id>");
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "user:42",
      normalized: "user:42",
    });

    expect(out).toEqual({
      to: "42",
      kind: "user",
      display: undefined,
      source: "normalized",
    });
  });

  it("resolves `channel:21` to a group target without a server call", async () => {
    const mock = withMockedFetch(() => {
      throw new Error("no server call expected for explicit channel:<id>");
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "channel:21",
      normalized: "channel:21",
    });

    expect(out?.kind).toBe("group");
    expect(out?.to).toBe("21");
  });

  it("resolves `@{N}` (canonicalized to `user:N`) without a server call", async () => {
    const mock = withMockedFetch(() => {
      throw new Error("no server call expected for mention form");
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "@{42}",
      normalized: "user:42",
    });

    expect(out).toEqual({
      to: "42",
      kind: "user",
      display: undefined,
      source: "normalized",
    });
  });

  it("respects an explicit `preferredKind: 'user'` for a bare id", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "42",
      normalized: "42",
      preferredKind: "user",
    });

    expect(out?.kind).toBe("user");
    expect(out?.to).toBe("42");
  });

  it("queries the rooms directory for `sabha:general` and returns directory source", async () => {
    // Regression: previously passed the raw `sabha:general` to the
    // resolver, which queried literally for that string and never
    // resolved. Now uses the normalized `general` form.
    const mock = withMockedFetch((url) => {
      if (url.includes("/rooms")) {
        return { body: [{ id: 9, name: "general" }] };
      }
      return { body: [] };
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "sabha:general",
      normalized: "general",
    });

    expect(out).toEqual({
      to: "9",
      kind: "group",
      display: "general",
      source: "directory",
    });
  });

  it("queries the users directory for `user:alice`", async () => {
    const mock = withMockedFetch((url) => {
      if (url.includes("/autocompletable/users")) {
        return { body: [{ id: 7, name: "alice" }] };
      }
      return { body: [] };
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "user:alice",
      normalized: "user:alice",
    });

    expect(out).toEqual({
      to: "7",
      kind: "user",
      display: "alice",
      source: "directory",
    });
  });

  it("returns null when the resolver cannot find a match", async () => {
    const mock = withMockedFetch((url) => {
      if (url.includes("/rooms")) return { body: [] };
      return { body: [] };
    });
    restore = mock.restore;

    const out = await resolveSabhaMessagingTarget({
      cfg: basicCfg(),
      accountId: "a",
      input: "no-such-room",
      normalized: "no-such-room",
    });

    expect(out).toBeNull();
  });
});

describe("inferSabhaTargetChatType", () => {
  it("infers `direct` from a `user:` prefix", () => {
    expect(inferSabhaTargetChatType("user:42")).toBe("direct");
    expect(inferSabhaTargetChatType("user:alice")).toBe("direct");
    // Case-insensitive — matches the canonical normalize forms.
    expect(inferSabhaTargetChatType("USER:42")).toBe("direct");
  });

  it("infers `group` from a `channel:` prefix", () => {
    expect(inferSabhaTargetChatType("channel:21")).toBe("group");
    expect(inferSabhaTargetChatType("channel:general")).toBe("group");
    expect(inferSabhaTargetChatType("CHANNEL:21")).toBe("group");
  });

  it("returns undefined for bare-numeric inputs (Sabha namespaces overlap)", () => {
    // Sabha rooms and users share the numeric id namespace. Without a
    // prefix the SDK can't tell direct from group; returning undefined
    // lets the SDK fall back to its own raw-prefix heuristics.
    expect(inferSabhaTargetChatType("21")).toBeUndefined();
    expect(inferSabhaTargetChatType("42")).toBeUndefined();
  });

  it("returns undefined for empty / whitespace-only input", () => {
    expect(inferSabhaTargetChatType("")).toBeUndefined();
    expect(inferSabhaTargetChatType("   ")).toBeUndefined();
  });

  it("returns undefined for an unknown prefix", () => {
    expect(inferSabhaTargetChatType("group:21")).toBeUndefined();
    expect(inferSabhaTargetChatType("dm:42")).toBeUndefined();
  });
});

describe("resolveSabhaDeliveryTarget", () => {
  it("strips the account scope before selecting a wire room", () => {
    expect(resolveSabhaDeliveryTarget({ conversationId: "primary:5" })).toEqual({ to: "channel:5" });
  });

  it("delivers directly to the thread room", () => {
    // Mirrors Mattermost's `channel.ts:311-317` exactly: parent ≠ child
    // means a thread session, so `to` is the parent and `threadId` is
    // the child (thread room).
    expect(
      resolveSabhaDeliveryTarget({
        conversationId: "99",
        parentConversationId: "5",
      }),
    ).toEqual({ to: "channel:99" });
  });

  it("returns just `to` for non-thread sessions", () => {
    expect(
      resolveSabhaDeliveryTarget({ conversationId: "5" }),
    ).toEqual({ to: "channel:5" });
  });

  it("treats parent === child as a non-thread session", () => {
    // Some session-grammar paths pass `parentConversationId` equal to
    // `conversationId` for non-thread cases. Don't emit a `threadId`
    // there — that would mis-attribute the conversation.
    expect(
      resolveSabhaDeliveryTarget({
        conversationId: "5",
        parentConversationId: "5",
      }),
    ).toEqual({ to: "channel:5" });
  });

  it("ignores blank parentConversationId", () => {
    expect(
      resolveSabhaDeliveryTarget({
        conversationId: "5",
        parentConversationId: "   ",
      }),
    ).toEqual({ to: "channel:5" });
  });

  it("returns null when the conversationId is empty", () => {
    expect(resolveSabhaDeliveryTarget({ conversationId: "" })).toBeNull();
    expect(
      resolveSabhaDeliveryTarget({ conversationId: "   " }),
    ).toBeNull();
  });
});

describe("buildSabhaThreadingToolContext", () => {
  function cfgWith(
    replyToMode: "off" | "first" | "all" | undefined,
  ): OpenClawConfig {
    return {
      channels: {
        sabha: {
          accounts: {
            a: {
              apiBaseUrl: "https://sabha.example/api/bots",
              botKey: "1-A",
              ...(replyToMode ? { replyToMode } : {}),
            },
          },
          defaultAccount: "a",
        },
      },
    } as unknown as OpenClawConfig;
  }

  it("surfaces account.replyToMode + ids for a top-level group inbound", () => {
    // This is the failure cell that motivated the helper. Without
    // `replyToMode` on the tool context, `message-action-runner-*.js`'s
    // `resolveAndApplyOutboundReplyToId` short-circuits and a `send`
    // action lands in the parent room instead of the thread.
    const hasRepliedRef = { value: false };
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith("first"),
      accountId: "a",
      context: {
        To: "1",
        ChatType: "channel",
        CurrentMessageId: "174",
      },
      hasRepliedRef,
    });
    expect(out).toEqual({
      currentChannelId: "1",
      currentMessageId: "174",
      currentThreadTs: undefined,
      replyToMode: "first",
      hasRepliedRef,
    });
  });

  it("forces replyToMode to 'off' for in-thread inbounds", () => {
    // Sabha threads ARE rooms — payload.room.id is the thread room.
    // Auto-injecting parentMessageId on top would create a nested
    // thread (server resolves a new thread room for that parent).
    // Verified against the wire contract documented in CLAUDE.md
    // ("Threading uses parentMessageId on sendMessage").
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith("first"),
      accountId: "a",
      context: {
        To: "42",
        ChatType: "channel",
        CurrentMessageId: "200",
        MessageThreadId: "42",
      },
    });
    expect(out.replyToMode).toBe("off");
    // currentThreadTs is still surfaced — future thread-aware verbs
    // (e.g. a hypothetical thread-info action) read it from here.
    expect(out.currentThreadTs).toBe("42");
  });

  it("forces replyToMode to 'off' for DMs", () => {
    // Sabha DMs don't model threads — collapse the mode so the
    // auto-inject path skips entirely. Same shape as the in-thread
    // case but driven by ChatType="direct" instead of MessageThreadId.
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith("first"),
      accountId: "a",
      context: {
        To: "9",
        ChatType: "direct",
        CurrentMessageId: "55",
      },
    });
    expect(out.replyToMode).toBe("off");
  });

  it("respects account.replyToMode === 'off' on a top-level group", () => {
    // The "off" cell should round-trip unchanged: an operator that
    // explicitly opted out of threading must not get auto-threading
    // back via the tool-context path.
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith("off"),
      accountId: "a",
      context: {
        To: "1",
        ChatType: "channel",
        CurrentMessageId: "100",
      },
    });
    expect(out.replyToMode).toBe("off");
  });

  it("defaults to 'first' when no replyToMode is configured", () => {
    // Match `resolveSabhaAccount`'s default. If this drifts we'd
    // silently revert to "off" on a fresh install and never thread.
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith(undefined),
      accountId: "a",
      context: {
        To: "1",
        ChatType: "channel",
        CurrentMessageId: "100",
      },
    });
    expect(out.replyToMode).toBe("first");
  });

  it("passes hasRepliedRef through unchanged", () => {
    // The SDK mutates `.value = true` after auto-inject fires, so the
    // exact reference must round-trip. Returning a fresh object would
    // make "first" mode auto-inject every send instead of just the
    // first one.
    const ref = { value: true };
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith("first"),
      accountId: "a",
      context: { To: "1", ChatType: "channel" },
      hasRepliedRef: ref,
    });
    expect(out.hasRepliedRef).toBe(ref);
  });

  it("trims and drops a blank `To` to undefined currentChannelId", () => {
    // The SDK's `isSameConversationTarget` gate compares the agent's
    // `to`/`target` against `currentChannelId.trim()`. Returning an
    // empty/whitespace string would silently disable auto-inject; we
    // want it explicitly undefined so the SDK fall-through is honest.
    const out = buildSabhaThreadingToolContext({
      cfg: cfgWith("first"),
      accountId: "a",
      context: { To: "   ", ChatType: "channel" },
    });
    expect(out.currentChannelId).toBeUndefined();
  });
});
