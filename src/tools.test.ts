import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { createSabhaTools } from "./tools.js";

// We assert that tools route HTTP traffic to the bot account's baseUrl by
// intercepting globalThis.fetch and reading the URL host. This is the
// minimum that proves the Feishu pattern (ctx.agentAccountId + hidden
// params.accountId override) actually selects the right bot.

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

function cfg(sabha: Record<string, unknown>): OpenClawConfig {
  return { channels: { sabha } } as unknown as OpenClawConfig;
}

const multiBotCfg = () =>
  cfg({
    baseUrl: "https://sabha.example/base",
    botKey: "1-BaseKey",
    botAccounts: {
      production: {
        baseUrl: "https://sabha.example/prod",
        botKey: "10-ProdKey",
      },
      staging: {
        baseUrl: "https://sabha.example/staging",
        botKey: "20-StagingKey",
      },
    },
    defaultBotAccount: "production",
  });

function buildListRoomsTool(getConfig: () => OpenClawConfig) {
  const tools = createSabhaTools(getConfig);
  const factory = tools.find((f) => f({ agentAccountId: undefined }).name === "sabha_list_rooms");
  if (!factory) throw new Error("sabha_list_rooms not registered");
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

    const factory = buildListRoomsTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });

    // Schema is a TypeBox object — its `properties` field should have
    // zero entries for sabha_list_rooms. The LLM never sees accountId.
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties ?? {}).toEqual({});
  });

  it("routes to the default bot account when no context is provided", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildListRoomsTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    await tool.execute("id", {});

    expect(mock.fetch).toHaveBeenCalledOnce();
    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("https://sabha.example/prod");
    expect(url).toContain("10-ProdKey");
  });

  it("routes to the account in ctx.agentAccountId when supplied", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildListRoomsTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: "staging" });
    await tool.execute("id", {});

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("https://sabha.example/staging");
    expect(url).toContain("20-StagingKey");
  });

  it("respects params.accountId override even though it is schema-hidden", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildListRoomsTool(() => multiBotCfg());
    // ctx says production, but the caller explicitly overrides to staging
    const tool = factory({ agentAccountId: "production" });
    await tool.execute("id", { accountId: "staging" });

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("https://sabha.example/staging");
  });

  it("works with a legacy single-bot config", async () => {
    const mock = withMockedFetch();
    restore = mock.restore;

    const factory = buildListRoomsTool(() =>
      cfg({ baseUrl: "https://sabha.example/solo", botKey: "7-SoloKey" }),
    );
    const tool = factory({ agentAccountId: undefined });
    await tool.execute("id", {});

    const url = String(mock.fetch.mock.calls[0][0]);
    expect(url).toContain("https://sabha.example/solo");
    expect(url).toContain("7-SoloKey");
  });

  it("returns a text + details result shape", async () => {
    const mock = withMockedFetch([{ id: 1, name: "General", type: "Open" }]);
    restore = mock.restore;

    const factory = buildListRoomsTool(() => multiBotCfg());
    const tool = factory({ agentAccountId: undefined });
    const result = await tool.execute("id", {});

    expect(result.content[0].type).toBe("text");
    expect(result.details).toEqual([
      { id: 1, name: "General", type: "Open" },
    ]);
  });
});
