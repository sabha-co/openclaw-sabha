import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SabhaAccountUnavailableError } from "./client/account-client.js";

const client = {
  listRooms: vi.fn(),
  listUsers: vi.fn(),
  searchUsers: vi.fn(),
};
let unavailable = false;
vi.mock("./client/account-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client/account-client.js")>();
  return {
    ...original,
    accountClient: () => {
      if (unavailable) throw new original.SabhaAccountUnavailableError({ accountId: "default", enabled: false });
      return { account: { accountId: "default" }, client };
    },
  };
});

const { listSabhaGroupMembers, listSabhaPeers, listSabhaPeersLive, resolveSabhaTargets } = await import("./directory.js");
const cfg = {} as OpenClawConfig;
const user = (id: number, name: string, bot = false) => ({ id, name, bot });

beforeEach(() => {
  vi.clearAllMocks();
  unavailable = false;
});

describe("directory listings", () => {
  it("pages through users, skipping apps, until a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => user(i + 1, `User ${i + 1}`, i === 0));
    client.listUsers.mockResolvedValueOnce(full).mockResolvedValueOnce([user(500, "Last")]);
    const peers = await listSabhaPeers({ cfg });
    expect(client.listUsers).toHaveBeenCalledTimes(2);
    expect(peers).toHaveLength(100);
    expect(peers[0]).toEqual({ kind: "user", id: "2", name: "User 2", handle: "User 2" });
  });

  it("stops at the limit", async () => {
    client.listUsers.mockResolvedValue(Array.from({ length: 100 }, (_, i) => user(i + 1, `U${i}`)));
    expect(await listSabhaPeers({ cfg, limit: 3 })).toHaveLength(3);
    expect(client.listUsers).toHaveBeenCalledTimes(1);
  });

  it("propagates lookup errors instead of returning nobody", async () => {
    client.searchUsers.mockRejectedValue(new Error("500"));
    await expect(listSabhaPeersLive({ cfg, query: "an" })).rejects.toThrow("500");
  });

  it("lists room members by prefixed id", async () => {
    client.listUsers.mockResolvedValue([user(5, "Ann")]);
    expect(await listSabhaGroupMembers({ cfg, groupId: "sabha:channel:21" })).toEqual([{ kind: "user", id: "5", name: "Ann", handle: "Ann" }]);
    expect(client.listUsers).toHaveBeenCalledWith({ roomId: 21, page: 1, perPage: 100 });
    await expect(listSabhaGroupMembers({ cfg, groupId: "general" })).rejects.toThrow("Not a Sabha room id");
  });
});

describe("resolveSabhaTargets", () => {
  it("passes ids through and prefers an exact name", async () => {
    client.searchUsers.mockResolvedValue([user(6, "Annie"), user(5, "ann"), user(9, "Bot", true)]);
    const results = await resolveSabhaTargets({ cfg, inputs: ["@{7}", "user:8", "@Ann", ""], kind: "user" });
    expect(results).toEqual([
      { input: "@{7}", resolved: true, id: "7" },
      { input: "user:8", resolved: true, id: "8" },
      { input: "@Ann", resolved: true, id: "5", name: "ann" },
      { input: "", resolved: false, note: "empty input" },
    ]);
  });

  it("notes ambiguity and misses, and caches repeated queries", async () => {
    client.listRooms.mockResolvedValueOnce([{ id: 1, name: "general-a" }, { id: 2, name: "general-b" }]).mockResolvedValueOnce([]);
    const results = await resolveSabhaTargets({ cfg, inputs: ["#general", "general", "#nothing"], kind: "group" });
    expect(results[0]).toMatchObject({ resolved: true, id: "1", note: "2 matches; chose general-a" });
    expect(results[1]).toMatchObject({ resolved: true, id: "1" });
    expect(results[2]).toEqual({ input: "#nothing", resolved: false, note: "no match" });
    expect(client.listRooms).toHaveBeenCalledTimes(2);
  });

  it("reports lookup failures distinctly from no match", async () => {
    client.searchUsers.mockRejectedValue(new Error("boom"));
    const [result] = await resolveSabhaTargets({ cfg, inputs: ["Ann"], kind: "user" });
    expect(result).toMatchObject({ resolved: false });
    expect(result!.note).toMatch(/^lookup failed: /);
  });

  it("notes an unavailable account on every input", async () => {
    unavailable = true;
    const results = await resolveSabhaTargets({ cfg, inputs: ["Ann", "5"], kind: "user" });
    expect(results.every((result) => !result.resolved && result.note?.includes("disabled"))).toBe(true);
    expect(SabhaAccountUnavailableError).toBeDefined();
  });
});
