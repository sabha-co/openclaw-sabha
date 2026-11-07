import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import type { SabhaClient } from "../client/client.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { SABHA_ACTION_NAMES, sabhaMessageActions } from "./adapter.js";
import { runSabhaAction, SABHA_ACTIONS } from "./handlers.js";

const account = { accountId: "default" } as ResolvedSabhaAccount;

function setup(action: string, params: Record<string, unknown>, toolContext: Record<string, unknown> = {}, failSendAt?: number) {
  const calls: string[] = [];
  let sends = 0;
  const client = {
    renderBody: (text: string) => text,
    sendMessage: vi.fn(async (roomId: number) => {
      if (sends === failSendAt) throw new Error("boom");
      calls.push("send");
      return { id: 900 + sends++, roomId };
    }),
    editMessage: vi.fn(async () => void calls.push("edit")),
    deleteMessage: vi.fn(async () => void calls.push("delete")),
    addReaction: vi.fn(async () => (calls.push("react"), 31)),
    readMessages: vi.fn(async () => ({ results: [], hasMore: true, nextCursor: "c2" })),
    search: vi.fn(async () => ({ results: [], hasMore: false, nextCursor: null })),
    createDm: vi.fn(async () => ({ roomId: 77 })),
  };
  const ctx = {
    action,
    params,
    cfg: {} as OpenClawConfig,
    toolContext,
    onPlatformSendDispatch: vi.fn(async () => void calls.push("dispatch")),
    assertDirectAdapterHandoff: vi.fn(),
  } as unknown as ChannelMessageActionContext;
  return { ctx, calls, client, run: () => runSabhaAction({ ctx, client: client as unknown as SabhaClient, account }) };
}

describe("message actions", () => {
  it("advertises exactly the handled actions", () => {
    expect([...SABHA_ACTION_NAMES].sort()).toEqual([...SABHA_ACTIONS].sort());
    expect(sabhaMessageActions.supportsAction?.({ action: "pin" } as never)).toBe(false);
    expect(sabhaMessageActions.supportsAction?.({ action: "search" } as never)).toBe(true);
  });

  it("sends to the current conversation, revalidating before the write", async () => {
    const { run, calls, client } = setup("send", { message: "hi" }, { currentChannelId: "channel:21" });
    expect(await run()).toMatchObject({ ok: true, messageId: "900", roomId: "21" });
    expect(calls).toEqual(["dispatch", "send"]);
    expect(client.sendMessage).toHaveBeenCalledWith(21, "hi", expect.anything());
  });

  it("opens a DM for a user target and threads a replyToId", async () => {
    const dm = setup("send", { target: "user:5", message: "hi" });
    expect(await dm.run()).toMatchObject({ roomId: "77" });
    const reply = setup("send", { target: "21", message: "hi", replyToId: "4214" });
    expect(await reply.run()).toMatchObject({ parentMessageId: "4214" });
  });

  it("requires a target outside a conversation", async () => {
    await expect(setup("send", { message: "hi" }).run()).rejects.toThrow("needs a target");
  });

  it("reacts to the current message by default", async () => {
    const { run, client } = setup("react", { emoji: "👍" }, { currentMessageId: "4214" });
    expect(await run()).toMatchObject({ ok: true, messageId: "4214", reactionId: "31" });
    expect(client.addReaction).toHaveBeenCalledWith(4214, "👍");
    await expect(setup("react", { emoji: "👍", messageId: 1, remove: true }).run()).rejects.toThrow("cannot remove");
  });

  it("edits and unsends by message id", async () => {
    const edit = setup("edit", { messageId: "12", message: "fixed" });
    await edit.run();
    expect(edit.client.editMessage).toHaveBeenCalledWith(12, "fixed");
    const unsend = setup("unsend", { message_id: 13 });
    await unsend.run();
    expect(unsend.calls).toEqual(["dispatch", "delete"]);
  });

  it("maps read cursors to `before` and caps the limit", async () => {
    const { run, client } = setup("read", { target: "21", cursor: "c1", limit: 999 });
    expect(await run()).toMatchObject({ hasMore: true, nextCursor: "c2" });
    expect(client.readMessages).toHaveBeenCalledWith(21, { before: "c1", limit: 200 });
  });

  it("scopes search by rooms and authors", async () => {
    const { run, client } = setup("search", { query: "deploy", channelIds: "21, 22", authorId: "5" });
    await run();
    expect(client.search).toHaveBeenCalledWith({ query: "deploy", roomIds: [21, 22], authorIds: [5] });
  });

  it.each(["send", "thread-reply"])("%s reports a partial delivery when a later chunk fails", async (action) => {
    const first = "a".repeat(11_000);
    const { run } = setup(action, { target: "21", messageId: "4214", message: `${first}\n\n${"b".repeat(11_000)}` }, {}, 1);
    const error = await run().catch((caught: unknown) => caught);
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect((error as { deliveryResult: unknown }).deliveryResult).toMatchObject({ messageIds: ["900"], content: first });
  });

  it("rethrows a failure before anything landed as is", async () => {
    const error = await setup("send", { target: "21", message: "hi" }, {}, 0).run().catch((caught: unknown) => caught);
    expect(isChannelPartialDeliveryError(error)).toBe(false);
  });

  it("rejects unknown actions", async () => {
    await expect(setup("pin", {}).run()).rejects.toThrow("does not support");
  });
});
