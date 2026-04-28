import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { resolveSabhaTargets } from "./resolver.js";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

type MockResponse = { body: unknown; status?: number };

function withMockedFetch(responder: (url: string) => MockResponse) {
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

function disabledCfg(): OpenClawConfig {
  return {
    channels: {
      sabha: {
        accounts: {
          a: {
            enabled: false,
            apiBaseUrl: "https://sabha.example/api/bots",
            botKey: "1-A",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function missingKeyCfg(): OpenClawConfig {
  return {
    channels: {
      sabha: {
        accounts: {
          a: {
            apiBaseUrl: "https://sabha.example/api/bots",
            // botKey deliberately absent
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("resolveSabhaTargets — user kind", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("passes numeric ids through without round-tripping the server", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["123"],
      kind: "user",
    });

    expect(results).toEqual([
      { input: "123", resolved: true, id: "123" },
    ]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("parses Sabha mention syntax @{id} as a numeric id", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["@{42}"],
      kind: "user",
    });

    expect(results).toEqual([
      { input: "@{42}", resolved: true, id: "42" },
    ]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("resolves a name via /autocompletable/users and takes the top match", async () => {
    const mock = withMockedFetch((url) => {
      expect(url).toContain("/autocompletable/users");
      expect(url).toContain("query=alex");
      return { body: [{ id: 7, name: "Alex Doe" }] };
    });
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["alex"],
      kind: "user",
    });

    expect(results).toEqual([
      { input: "alex", resolved: true, id: "7", name: "Alex Doe" },
    ]);
  });

  it("strips a leading @ before searching for a name", async () => {
    const mock = withMockedFetch((url) => {
      expect(url).toContain("query=alex");
      return { body: [{ id: 7, name: "Alex" }] };
    });
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["@alex"],
      kind: "user",
    });

    expect(results[0]).toMatchObject({ resolved: true, id: "7" });
  });

  it("flags multiple-matches when more than one user comes back", async () => {
    const mock = withMockedFetch(() => ({
      body: [
        { id: 7, name: "Alex Doe" },
        { id: 8, name: "Alexei Putin" },
      ],
    }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["alex"],
      kind: "user",
    });

    expect(results[0]).toMatchObject({
      resolved: true,
      id: "7",
      note: "multiple matches; chose best",
    });
  });

  it("returns unresolved when a name has no matches", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["nobody"],
      kind: "user",
    });

    expect(results).toEqual([{ input: "nobody", resolved: false }]);
  });

  it("caches identical name queries within a single batch", async () => {
    const mock = withMockedFetch(() => ({
      body: [{ id: 7, name: "Alex" }],
    }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["alex", "ALEX", "alex"],
      kind: "user",
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.resolved && r.id === "7")).toBe(true);
    // Three inputs, one underlying server call.
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a search failure from a no-match (lookup-failed note)", async () => {
    // 500 means the lookup itself failed — agents should not treat this
    // the same as a clean "no Alex in this workspace" miss. Without the
    // note an agent would happily fabricate a name → user pairing on
    // the next turn.
    const mock = withMockedFetch(() => ({ body: "boom", status: 500 }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["alex"],
      kind: "user",
    });

    expect(results[0]).toEqual({
      input: "alex",
      resolved: false,
      note: "lookup failed",
    });
  });

  it("returns unresolved-with-note when the account is disabled", async () => {
    const results = await resolveSabhaTargets({
      cfg: disabledCfg(),
      inputs: ["123", "alex"],
      kind: "user",
    });

    expect(results).toEqual([
      { input: "123", resolved: false, note: "Sabha account disabled" },
      { input: "alex", resolved: false, note: "Sabha account disabled" },
    ]);
  });

  it("returns unresolved-with-note when the bot key is missing", async () => {
    const results = await resolveSabhaTargets({
      cfg: missingKeyCfg(),
      inputs: ["alex"],
      kind: "user",
    });

    expect(results[0]).toMatchObject({
      resolved: false,
      note: "missing Sabha bot key or apiBaseUrl",
    });
  });
});

describe("resolveSabhaTargets — group kind", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("passes numeric ids through without round-tripping the server", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["55"],
      kind: "group",
    });

    expect(results).toEqual([{ input: "55", resolved: true, id: "55" }]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("strips leading # before resolving a name and matches against listRooms", async () => {
    const mock = withMockedFetch((url) => {
      expect(url).toContain("/rooms");
      expect(url).toContain("query=general");
      return {
        body: [{ id: 1, name: "general", type: "Open" }],
      };
    });
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["#general"],
      kind: "group",
    });

    expect(results[0]).toMatchObject({
      input: "#general",
      resolved: true,
      id: "1",
      name: "general",
    });
  });

  it("caches identical name queries within a single batch", async () => {
    // Different names mean different server calls; duplicate names share
    // one cached response. ["general", "random", "general"] = 2 calls.
    const responses: Record<string, { id: number; name: string }[]> = {
      general: [{ id: 1, name: "general" }],
      random: [{ id: 2, name: "random" }],
    };
    const mock = withMockedFetch((url) => {
      const m = url.match(/query=([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : "";
      return { body: responses[key] ?? [] };
    });
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["general", "random", "general"],
      kind: "group",
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ resolved: true, id: "1" });
    expect(results[1]).toMatchObject({ resolved: true, id: "2" });
    expect(results[2]).toMatchObject({ resolved: true, id: "1" });
    // Two distinct queries, third input is a cache hit.
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns unresolved when the server returns no matches", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["does-not-exist"],
      kind: "group",
    });

    expect(results[0]).toEqual({ input: "does-not-exist", resolved: false });
  });

  it("flags multiple-matches when the query matches more than one room", async () => {
    const mock = withMockedFetch(() => ({
      body: [
        { id: 1, name: "team-alpha", type: "Open" },
        { id: 2, name: "team-beta", type: "Open" },
      ],
    }));
    restore = mock.restore;

    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["team"],
      kind: "group",
    });

    expect(results[0]).toMatchObject({
      resolved: true,
      id: "1",
      note: "multiple matches; chose best",
    });
  });
});

describe("resolveSabhaTargets — empty / whitespace inputs", () => {
  it("returns unresolved-with-note for empty input strings", async () => {
    const results = await resolveSabhaTargets({
      cfg: basicCfg(),
      inputs: ["", "   "],
      kind: "user",
    });

    expect(results).toEqual([
      { input: "", resolved: false, note: "empty input" },
      { input: "   ", resolved: false, note: "empty input" },
    ]);
  });

  it("returns [] for an empty inputs array without hitting the network", async () => {
    const mock = withMockedFetch(() => ({ body: [] }));
    const restore = mock.restore;
    try {
      const results = await resolveSabhaTargets({
        cfg: basicCfg(),
        inputs: [],
        kind: "user",
      });
      expect(results).toEqual([]);
      expect(mock.fetch).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("resolveSabhaTargets — group lookup-failed signal", () => {
  it("flags lookup-failed when listRooms throws (vs. clean no-match)", async () => {
    const mock = withMockedFetch(() => ({ body: "boom", status: 500 }));
    const restore = mock.restore;
    try {
      const results = await resolveSabhaTargets({
        cfg: basicCfg(),
        inputs: ["general"],
        kind: "group",
      });
      expect(results[0]).toEqual({
        input: "general",
        resolved: false,
        note: "lookup failed",
      });
    } finally {
      restore();
    }
  });

  it("only issues one listRooms call per inputs batch (no pagination)", async () => {
    // resolveTargets is name → id, not enumeration. We never page past
    // the first server response — if the server caps the per-call match
    // count, the first 50/100/whatever is the resolution surface.
    let callCount = 0;
    const mock = withMockedFetch(() => {
      callCount++;
      return { body: [{ id: 1, name: "general", type: "Open" }] };
    });
    const restore = mock.restore;
    try {
      await resolveSabhaTargets({
        cfg: basicCfg(),
        inputs: ["general"],
        kind: "group",
      });
      expect(callCount).toBe(1);
    } finally {
      restore();
    }
  });
});
