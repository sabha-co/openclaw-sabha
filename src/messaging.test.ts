import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  looksLikeSabhaTargetId,
  normalizeSabhaMessagingTarget,
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
