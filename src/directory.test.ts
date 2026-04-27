import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  listSabhaDirectoryGroupMembers,
  listSabhaDirectoryGroups,
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

describe("listSabhaDirectoryGroupMembers", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("returns members of the named room as user entries", async () => {
    const mock = withMockedFetch([
      {
        body: [
          { id: 100, name: "Alice", role: "member" },
          { id: 200, name: "Bob", role: "moderator" },
        ],
      },
    ]);
    restore = mock.restore;

    const entries = await listSabhaDirectoryGroupMembers({
      cfg: multiBotCfg(),
      groupId: "42",
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "user", id: "100", name: "Alice" });
    expect(String(mock.fetch.mock.calls[0][0])).toBe(
      "https://sabha.example/a/api/bots/rooms/42/members",
    );
  });

  it("returns [] for a non-numeric groupId", async () => {
    const entries = await listSabhaDirectoryGroupMembers({
      cfg: multiBotCfg(),
      groupId: "not-a-number",
    });
    expect(entries).toEqual([]);
  });
});
