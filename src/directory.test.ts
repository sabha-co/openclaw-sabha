import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  listSabhaDirectoryGroups,
  listSabhaDirectoryPeers,
  listSabhaDirectoryPeersLive,
} from "./directory.js";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function withMockedFetch(responses: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  const fetch = vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
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

function multiBotCfg(): OpenClawConfig {
  return {
    channels: {
      sabha: {
        accounts: {
          a: {
            apiBaseUrl: "https://sabha.example/a/api/bots",
            botKey: "1-A",
          },
          b: {
            apiBaseUrl: "https://sabha.example/b/api/bots",
            botKey: "2-B",
          },
        },
        defaultAccount: "a",
      },
    },
  } as unknown as OpenClawConfig;
}

function disabledDefaultCfg(): OpenClawConfig {
  return {
    channels: {
      sabha: {
        accounts: {
          a: {
            enabled: false,
            apiBaseUrl: "https://sabha.example/a/api/bots",
            botKey: "1-A",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("listSabhaDirectoryGroups", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("returns rooms from the resolved bot as group entries", async () => {
    const mock = withMockedFetch([
      { body: [{ id: 1, name: "general", type: "Open" }, { id: 2, name: "random", type: "Open" }] },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroups({ cfg: multiBotCfg() });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "group", id: "1", name: "general" });
    expect(entries[1]).toMatchObject({ kind: "group", id: "2", name: "random" });
  });

  it("scopes to the default account when accountId is null (does NOT union all accounts)", async () => {
    // Cross-tenant safety: account 'a' and account 'b' may be different
    // workspaces with overlapping room ids. Listing only the default
    // account guarantees ids round-trip cleanly to message-action sends.
    const mock = withMockedFetch([
      { body: [{ id: 1, name: "default-only", type: "Open" }] },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroups({ cfg: multiBotCfg() });

    // One fetch only — to the default account 'a', not both.
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(String(mock.fetch.mock.calls[0][0])).toBe(
      "https://sabha.example/a/api/bots/rooms",
    );
    expect(entries.map((e) => e.id)).toEqual(["1"]);
  });

  it("returns [] when the resolved account is disabled", async () => {
    const mock = withMockedFetch([{ body: [] }]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroups({ cfg: disabledDefaultCfg() });

    expect(entries).toEqual([]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("filters by query (case-insensitive substring on name)", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 1, name: "general", type: "Open" },
          { id: 2, name: "Random", type: "Open" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroups({
      cfg: multiBotCfg(),
      query: "rand",
    });

    expect(entries.map((e) => e.id)).toEqual(["2"]);
  });

  it("respects limit", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 1, name: "a", type: "Open" },
          { id: 2, name: "b", type: "Open" },
          { id: 3, name: "c", type: "Open" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroups({ cfg: multiBotCfg(), limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("scopes to one account when accountId is provided", async () => {
    const mock = withMockedFetch([
      { body: [{ id: 9, name: "only-on-a", type: "Open" }] },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroups({
      cfg: multiBotCfg(),
      accountId: "a",
    });

    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(String(mock.fetch.mock.calls[0][0])).toBe("https://sabha.example/a/api/bots/rooms");
    expect(entries).toHaveLength(1);
  });
});

describe("listSabhaDirectoryPeers", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("returns reachable users from /api/bots/users with page=1 perPage=100", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 100, name: "Alice", role: "member", bot: false, url: "/u/alice" },
          { id: 200, name: "Bob", role: "moderator", bot: false, url: "/u/bob" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({ cfg: multiBotCfg() });

    expect(mock.fetch).toHaveBeenCalledOnce();
    // Short page (2 < 100) signals last page — no extra round-trip.
    expect(String(mock.fetch.mock.calls[0][0])).toBe(
      "https://sabha.example/a/api/bots/users?page=1&per_page=100",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "user", id: "100", name: "Alice" });
  });

  it("paginates through multiple pages until a short page signals the last", async () => {
    // Page 1: 100 users (full page → fetch more); page 2: 50 users (short → stop).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `U${i + 1}`,
      role: "member",
      bot: false,
      url: `/u/${i + 1}`,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      id: 101 + i,
      name: `U${101 + i}`,
      role: "member",
      bot: false,
      url: `/u/${101 + i}`,
    }));
    const mock = withMockedFetch([{ body: page1 }, { body: page2 }]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({ cfg: multiBotCfg() });

    expect(mock.fetch).toHaveBeenCalledTimes(2);
    expect(String(mock.fetch.mock.calls[0][0])).toContain("page=1");
    expect(String(mock.fetch.mock.calls[1][0])).toContain("page=2");
    expect(entries).toHaveLength(150);
    expect(entries[0].id).toBe("1");
    expect(entries[149].id).toBe("150");
  });

  it("stops paginating early when caller's limit is reached mid-page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `U${i + 1}`,
      role: "member",
      bot: false,
      url: `/u/${i + 1}`,
    }));
    const mock = withMockedFetch([{ body: page1 }]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({
      cfg: multiBotCfg(),
      limit: 5,
    });

    // Only one fetch — the limit is satisfied within page 1, so we never
    // request page 2. (Workspace might have thousands of users; we stop.)
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns partial results on a mid-stream fetch failure", async () => {
    // Page 1 succeeds with a full page; page 2 errors. Adapter returns
    // the page-1 entries it already has rather than throwing or wiping.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `U${i + 1}`,
      role: "member",
      bot: false,
      url: `/u/${i + 1}`,
    }));
    const mock = withMockedFetch([{ body: page1 }, { body: "boom", status: 500 }]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({ cfg: multiBotCfg() });

    expect(entries).toHaveLength(100);
    expect(entries[0].id).toBe("1");
  });

  it("filters out bot users so agents don't see other bots in the directory", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 1, name: "Alice", role: "member", bot: false, url: "/u/1" },
          { id: 2, name: "OpsBot", role: "bot", bot: true, url: "/u/2" },
          { id: 3, name: "Bob", role: "member", bot: false, url: "/u/3" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({ cfg: multiBotCfg() });

    expect(entries.map((e) => e.id)).toEqual(["1", "3"]);
  });

  it("filters by query (case-insensitive substring on name)", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 1, name: "Alice", role: "member", bot: false, url: "/u/1" },
          { id: 2, name: "Albert", role: "member", bot: false, url: "/u/2" },
          { id: 3, name: "Bob", role: "member", bot: false, url: "/u/3" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({
      cfg: multiBotCfg(),
      query: "AL",
    });

    expect(entries.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("scopes to the default account when accountId is null", async () => {
    const mock = withMockedFetch([
      { body: [{ id: 9, name: "Carol", role: "member", bot: false, url: "/u/9" }] },
    ]);
    restore = mock.restore;

    await listSabhaDirectoryPeers({ cfg: multiBotCfg() });

    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(String(mock.fetch.mock.calls[0][0])).toContain(
      "https://sabha.example/a/api/bots/users",
    );
  });

  it("returns [] when the account is disabled", async () => {
    const mock = withMockedFetch([{ body: [] }]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeers({ cfg: disabledDefaultCfg() });

    expect(entries).toEqual([]);
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});

describe("listSabhaDirectoryPeersLive", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("hits /autocompletable/users with the trimmed query", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 5, name: "Ash", role: "member", bot: false, url: "/u/5" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeersLive({
      cfg: multiBotCfg(),
      query: "  Ash  ",
    });

    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(String(mock.fetch.mock.calls[0][0])).toBe(
      "https://sabha.example/a/api/bots/autocompletable/users?query=Ash",
    );
    expect(entries.map((e) => e.id)).toEqual(["5"]);
  });

  it("omits the query param when query is empty/whitespace", async () => {
    const mock = withMockedFetch([{ body: [] }]);
    restore = mock.restore;

    await listSabhaDirectoryPeersLive({ cfg: multiBotCfg(), query: "   " });

    expect(String(mock.fetch.mock.calls[0][0])).toBe(
      "https://sabha.example/a/api/bots/autocompletable/users",
    );
  });

  it("filters out bot users", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 1, name: "Alice", role: "member", bot: false, url: "/u/1" },
          { id: 2, name: "OpsBot", role: "bot", bot: true, url: "/u/2" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryPeersLive({
      cfg: multiBotCfg(),
      query: "a",
    });

    expect(entries.map((e) => e.id)).toEqual(["1"]);
  });
});
