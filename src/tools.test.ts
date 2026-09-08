import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { createSabhaTools } from "./tools.js";

// We assert that tools route HTTP traffic to the bot account's apiBaseUrl
// by intercepting globalThis.fetch and reading the URL + Authorization
// header. This is the minimum that proves the Feishu pattern
// (ctx.agentAccountId + hidden params.accountId override) actually
// selects the right bot. Also covers the two safety guards that fall
// out of the Sabha-side audit: unknown agentAccountId → fall back to
// default; disabled account → throw a typed error.

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function withMockedFetch(body: unknown = []) {
  const fetch = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", Location: "/rooms/1" },
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

function authHeader(call: Parameters<typeof globalThis.fetch>): string | null {
  const init = call[1];
  if (!init?.headers) return null;
  const h =
    init.headers instanceof Headers
      ? init.headers
      : new Headers(init.headers as HeadersInit);
  return h.get("Authorization");
}

function cfg(sabha: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

const multiBotCfg = () =>
  cfg({
    baseUrl: "https://sabha.example/base",
    apiBaseUrl: "https://sabha.example/base/api/bots",
    botKey: "1-BaseKey",
    accounts: {
      production: {
        baseUrl: "https://sabha.example/prod",
        apiBaseUrl: "https://sabha.example/prod/api/bots",
        botKey: "10-ProdKey",
      },
      staging: {
        baseUrl: "https://sabha.example/staging",
        apiBaseUrl: "https://sabha.example/staging/api/bots",
        botKey: "20-StagingKey",
      },
    },
    defaultAccount: "production",
  });

// Account-routing tests use `sabha_search_members` as the fixture because
// it's one of the two retained `registerTool` factories. The behavior under
// test (precedence of params.accountId / ctx.agentAccountId / default,
// disabled-account error, schema doesn't expose accountId) is generic to
// all tools, so any retained factory works.
function buildAccountRoutingTool(getConfig: () => OpenClawConfig) {
  const tools = createSabhaTools(getConfig);
  const factory = tools.find(
    (f) => f({ agentAccountId: undefined }).name === "sabha_search_members",
  );
  if (!factory) throw new Error("sabha_search_members not registered");
  return factory;
}

describe("createSabhaTools — account routing", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  it("does not expose an accountId parameter in the tool schema", () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });

    // The LLM-visible schema only carries pagination/query knobs; the
    // hidden `accountId` override is not advertised. (After the listRooms
    // pagination reshape, query/page/per_page are intentionally exposed.)
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).not.toContain("accountId");
  });

  it("routes to the default bot account when no context is provided", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    await tool.execute("id", {});

    expect(mock.fetch).toHaveBeenCalledOnce();
    const call = mock.fetch.mock.calls[0];
    const url = String(call[0]);
    expect(url).toContain("https://sabha.example/prod/api/bots");
    expect(authHeader(call)).toBe("Bearer 10-ProdKey");
  });

  it("routes to the account in ctx.agentAccountId when supplied", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: "staging" });
    await tool.execute("id", {});

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toContain("https://sabha.example/staging/api/bots");
    expect(authHeader(call)).toBe("Bearer 20-StagingKey");
  });

  it("respects params.accountId override even though it is schema-hidden", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() => multiBotCfg());
    // ctx says production, but the caller explicitly overrides to staging
    const tool = factory({ agentAccountId: "production" });
    await tool.execute("id", { accountId: "staging" });

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toContain("https://sabha.example/staging/api/bots");
    expect(authHeader(call)).toBe("Bearer 20-StagingKey");
  });

  it("works with a single-bot config", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() =>
      cfg({
        accounts: {
          default: {
            baseUrl: "https://sabha.example/solo",
            apiBaseUrl: "https://sabha.example/solo/api/bots",
            botKey: "7-SoloKey",
          },
        },
      }),
    );
    const tool = factory({ agentAccountId: undefined });
    await tool.execute("id", {});

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toContain("https://sabha.example/solo/api/bots");
    expect(authHeader(call)).toBe("Bearer 7-SoloKey");
  });

  it("falls back to the default account when agentAccountId names a non-existent account", async () => {
    // Mirrors Feishu's tool-account-routing.test.ts:142 — a stray
    // `agentAccountId` from a different channel's routing context (e.g.
    // a Slack workspace id) should not produce a degenerate base-only
    // resolve. We fall back to the configured default instead.
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: "agent-spawner" });
    await tool.execute("id", {});

    const call = mock.fetch.mock.calls[0];
    expect(String(call[0])).toContain("https://sabha.example/prod/api/bots");
    expect(authHeader(call)).toBe("Bearer 10-ProdKey");
  });

  it("returns an Error result when the resolved account is disabled", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() =>
      cfg({
        accounts: {
          default: {
            enabled: false,
            baseUrl: "https://sabha.example/disabled",
            apiBaseUrl: "https://sabha.example/disabled/api/bots",
            botKey: "9-DisabledKey",
          },
        },
      }),
    );
    const tool = factory({ agentAccountId: undefined });
    const result = await tool.execute("id", {});

    expect(mock.fetch).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/disabled/i);
    expect((result.details as { error?: string }).error).toMatch(/disabled/i);
  });

  it("rejects an unknown explicit account without falling back across tenants", async () => {
    const mock = withMockedFetch(); restore = mock.restore;
    const tool = buildAccountRoutingTool(multiBotCfg)({ agentAccountId: "production" });
    const result = await tool.execute("id", { accountId: "missing" });
    expect(result.content[0].text).toContain("Unknown Sabha account");
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("rejects a named account without credentials before making an API call", async () => {
    const mock = withMockedFetch(); restore = mock.restore;
    const tool = buildAccountRoutingTool(() => cfg({ accounts: { default: { baseUrl: "https://sabha.example" } } }))({});
    expect((await tool.execute("id", {})).content[0].text).toContain("not configured");
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("returns a text + details result shape", async () => {
    const mock = withMockedFetch([{ id: 1, name: "Alice" }]);
    restore = mock.restore;

    const factory = buildAccountRoutingTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    const result = await tool.execute("id", {});

    expect(result.content[0].type).toBe("text");
    expect(result.details).toEqual([{ id: 1, name: "Alice" }]);
  });
});

describe("createSabhaTools — sabha_search_members", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  function buildSearchMembersTool(getConfig: () => OpenClawConfig) {
    const tools = createSabhaTools(getConfig);
    const factory = tools.find(
      (f) => f({ agentAccountId: undefined }).name === "sabha_search_members",
    );
    if (!factory) throw new Error("sabha_search_members not registered");
    return factory;
  }

  it("hits /autocompletable/users with both room_id and query params", async () => {
    const mock = withMockedFetch([{ id: 7, name: "Alex" }]);
    restore = mock.restore;

    const factory = buildSearchMembersTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    await tool.execute("id", { room_id: 42, query: "alex" });

    expect(mock.fetch).toHaveBeenCalledOnce();
    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("/autocompletable/users");
    expect(url).toContain("query=alex");
    expect(url).toContain("room_id=42");
  });

  it("omits the query param when the agent doesn't supply one", async () => {
    const mock = withMockedFetch([]);
    restore = mock.restore;

    const factory = buildSearchMembersTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    await tool.execute("id", { room_id: 99 });

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("room_id=99");
    expect(url).not.toContain("query=");
  });

  it("returns the user list verbatim in details", async () => {
    const users = [
      { id: 7, name: "Alex Doe" },
      { id: 8, name: "Alexei Putin" },
    ];
    const mock = withMockedFetch(users);
    restore = mock.restore;

    const factory = buildSearchMembersTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    const result = await tool.execute("id", { room_id: 42, query: "alex" });

    expect(result.details).toEqual(users);
  });

  it("declares room_id as required and query as optional in the JSON schema", () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildSearchMembersTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    const schema = tool.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toContain("room_id");
    expect(Object.keys(schema.properties)).toContain("query");
    expect(schema.required).toEqual(["room_id"]);
  });
});
