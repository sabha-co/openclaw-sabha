import { describe, expect, it, vi } from "vitest";
import type { SabhaClient } from "../client/client.js";
import { parseSabhaTarget, resolveSendTarget } from "./target.js";

describe("parseSabhaTarget", () => {
  it("reads channels, users and mentions", () => {
    expect(parseSabhaTarget("21")).toEqual({ kind: "channel", id: 21 });
    expect(parseSabhaTarget("sabha:channel:21")).toEqual({ kind: "channel", id: 21 });
    expect(parseSabhaTarget("user:5")).toEqual({ kind: "user", id: 5 });
    expect(parseSabhaTarget("@{5}")).toEqual({ kind: "user", id: 5 });
    expect(parseSabhaTarget("general")).toBeNull();
  });
});

describe("resolveSendTarget", () => {
  const client = { createDm: vi.fn(async () => ({ channelId: 77 })) } as unknown as SabhaClient;

  it("posts into the thread channel when one is named", async () => {
    await expect(resolveSendTarget({ client, to: "3", threadId: "221", replyToId: "4214" })).resolves.toEqual({ channelId: 221 });
  });

  it("threads under a message in a channel", async () => {
    await expect(resolveSendTarget({ client, to: "3", replyToId: "4214" })).resolves.toEqual({ channelId: 3, parentMessageId: 4214 });
  });

  it("reaches a user through their DM", async () => {
    await expect(resolveSendTarget({ client, to: "user:5", replyToId: "9" })).resolves.toEqual({ channelId: 77 });
    expect(client.createDm).toHaveBeenCalledWith([5]);
  });

  it("refuses targets it cannot address", async () => {
    await expect(resolveSendTarget({ client, to: "general" })).rejects.toThrow(/Not a Sabha target/);
  });
});
