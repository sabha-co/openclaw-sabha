import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = { searchUsers: vi.fn(), createDm: vi.fn() };
const accountIds: Array<string | null | undefined> = [];
vi.mock("./client/account-client.js", () => ({
  accountClient: (_cfg: unknown, accountId?: string | null) => (accountIds.push(accountId), { account: {}, client }),
}));

const { createSabhaTools } = await import("./tools.js");
const { SABHA_TOOL_NAMES } = await import("./plugin/meta.js");

const cfg = {} as OpenClawConfig;
const tools = createSabhaTools(() => cfg);
const ctx = (extra: Record<string, unknown> = {}) => ({ assertInvocationCurrent: vi.fn(), ...extra }) as never;
const details = (result: { details: unknown }) => result.details as Record<string, unknown> & Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  accountIds.length = 0;
});

describe("sabha tools", () => {
  it("registers v2 factories in SABHA_TOOL_NAMES order", () => {
    expect(tools.map((tool) => tool.contextVersion)).toEqual([2, 2]);
    expect(tools.map((tool) => tool.create(ctx()).name)).toEqual([...SABHA_TOOL_NAMES]);
  });

  it("searches the current Sabha room on the turn's account", async () => {
    client.searchUsers.mockResolvedValue([{ id: 5, name: "Ann" }, { id: 9, name: "Helper", bot: true }]);
    const tool = tools[0]!.create(ctx({ messageChannel: "sabha", nativeChannelId: "21", agentAccountId: "work" }));
    const result = await tool.execute("call-1", { query: "an" });
    expect(client.searchUsers).toHaveBeenCalledWith({ roomId: 21, query: "an" });
    expect(accountIds).toEqual(["work"]);
    expect(details(result)).toEqual([{ id: 5, name: "Ann", mention: "@{5}" }, { id: 9, name: "Helper", mention: "@{9}", app: true }]);
  });

  it("ignores another channel's room and account", async () => {
    const tool = tools[0]!.create(ctx({ messageChannel: "slack", nativeChannelId: "21", agentAccountId: "work" }));
    const result = await tool.execute("call-1", {});
    expect(details(result).error).toMatch("room_id is required");
    expect(accountIds).toEqual([undefined]);
  });

  it("checks invocation currency before opening a DM", async () => {
    client.createDm.mockResolvedValue({ roomId: 77 });
    const context = ctx();
    const result = await tools[1]!.create(context).execute("call-2", { user_id: 5 });
    expect((context as { assertInvocationCurrent: ReturnType<typeof vi.fn> }).assertInvocationCurrent).toHaveBeenCalled();
    expect(details(result)).toEqual({ roomId: 77, target: "channel:77" });
  });

  it("does not open a DM when the invocation is stale", async () => {
    const context = ctx({ assertInvocationCurrent: () => { throw new Error("stale"); } });
    const result = await tools[1]!.create(context).execute("call-3", { user_id: 5 });
    expect(details(result).error).toBe("stale");
    expect(client.createDm).not.toHaveBeenCalled();
  });
});
