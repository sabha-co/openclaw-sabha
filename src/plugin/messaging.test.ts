import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it, vi } from "vitest";

const createDm = vi.fn(async () => ({ roomId: 77 }));
vi.mock("../client/account-client.js", () => ({
  accountClient: () => ({ account: { accountId: "default" }, client: { createDm } }),
}));

const {
  buildSabhaThreadingToolContext,
  inferSabhaTargetChatType,
  looksLikeSabhaTargetId,
  normalizeSabhaTarget,
  resolveSabhaDeliveryTarget,
  resolveSabhaOutboundSessionRoute,
} = await import("./messaging.js");

const KEY = "sabha_app_0123456789abcdef0123456789abcdef";
const cfg = { channels: { sabha: { url: "https://sabha.test", appKey: KEY } } } as unknown as OpenClawConfig;

describe("normalizeSabhaTarget", () => {
  it.each([
    ["21", "channel:21"],
    ["sabha:21", "channel:21"],
    ["room:21", "channel:21"],
    ["group:21", "channel:21"],
    ["@{5}", "user:5"],
    ["user:@{5}", "user:5"],
    ["USER:5", "user:5"],
    ["@Ann", "user:Ann"],
    ["#general", "channel:general"],
    ["general", "general"],
  ])("%s → %s", (raw, expected) => expect(normalizeSabhaTarget(raw)).toBe(expected));

  it("rejects empty targets", () => {
    for (const raw of ["", "  ", "sabha:", "user:", "@", "#"]) expect(normalizeSabhaTarget(raw)).toBeUndefined();
  });
});

describe("target classification", () => {
  it("treats numeric and kinded numeric targets as ids", () => {
    expect(looksLikeSabhaTargetId("21")).toBe(true);
    expect(looksLikeSabhaTargetId("@{5}")).toBe(true);
    expect(looksLikeSabhaTargetId("#general", "channel:general")).toBe(false);
    expect(looksLikeSabhaTargetId("@Ann", "user:5")).toBe(true);
  });

  it("infers chat type from the kind", () => {
    expect(inferSabhaTargetChatType("user:5")).toBe("direct");
    expect(inferSabhaTargetChatType("channel:21")).toBe("group");
    expect(inferSabhaTargetChatType("general")).toBeUndefined();
  });

  it("delivers thread sessions straight into the thread room", () => {
    expect(resolveSabhaDeliveryTarget({ conversationId: "221" })).toEqual({ to: "channel:221" });
    expect(resolveSabhaDeliveryTarget({ conversationId: "default:221" })).toEqual({ to: "channel:221" });
    expect(resolveSabhaDeliveryTarget({ conversationId: "nope" })).toBeNull();
  });
});

describe("resolveSabhaOutboundSessionRoute", () => {
  it("keys a user target by its DM room", async () => {
    const route = await resolveSabhaOutboundSessionRoute({ cfg, agentId: "main", target: "user:5" });
    expect(createDm).toHaveBeenCalledWith([5]);
    expect(route?.sessionKey).toContain("77");
    expect(route?.chatType).toBe("direct");
  });

  it("routes a room target as a group, and a thread send to the thread room's session", async () => {
    const plain = await resolveSabhaOutboundSessionRoute({ cfg, agentId: "main", target: "channel:21" });
    const threaded = await resolveSabhaOutboundSessionRoute({ cfg, agentId: "main", target: "channel:21", threadId: 221 });
    const threadRoom = await resolveSabhaOutboundSessionRoute({ cfg, agentId: "main", target: "channel:221" });
    expect(plain?.chatType).toBe("group");
    expect(plain?.sessionKey).toBe("agent:main:sabha:group:default:21");
    expect(threaded?.sessionKey).toBe(threadRoom?.sessionKey);
  });

  it("returns null when the DM cannot be opened", async () => {
    createDm.mockRejectedValueOnce(new Error("403"));
    expect(await resolveSabhaOutboundSessionRoute({ cfg, agentId: "main", target: "user:5" })).toBeNull();
  });
});

describe("buildSabhaThreadingToolContext", () => {
  it("threads top-level group replies per the account mode", () => {
    const context = buildSabhaThreadingToolContext({ cfg, context: { To: "channel:21", ChatType: "group", CurrentMessageId: 4214 } });
    expect(context).toMatchObject({ currentChannelId: "channel:21", currentMessageId: 4214 });
    expect(context.replyToMode).not.toBe("off");
  });

  it("does not nest threads or thread DMs", () => {
    expect(buildSabhaThreadingToolContext({ cfg, context: { To: "channel:221", ChatType: "group", MessageThreadId: 221 } })).toMatchObject({
      replyToMode: "off",
      currentThreadTs: "221",
    });
    expect(buildSabhaThreadingToolContext({ cfg, context: { To: "channel:9", ChatType: "direct" } }).replyToMode).toBe("off");
  });
});
