import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import type { SabhaClient } from "../client/client.js";
import type { SabhaDraftFrame } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";
import { createSabhaDraft } from "./draft-transport.js";
import { createSabhaReplyDelivery } from "./reply-delivery.js";

const account = { accountId: "default", allowPrivateNetwork: false } as ResolvedSabhaAccount;
const target = { roomId: 3, parentMessageId: 4214 };

function setup(options: { withDraft?: boolean; failSendAt?: number } = {}) {
  const frames: SabhaDraftFrame[] = [];
  const posts: Array<{ roomId: number; text: string; options: unknown }> = [];
  let nextId = 900;
  const client = {
    sendMessage: vi.fn(async (roomId: number, text: string, sendOptions: unknown) => {
      if (options.failSendAt === posts.length) throw new Error("boom");
      posts.push({ roomId, text, options: sendOptions });
      return { id: nextId++, roomId: 221 };
    }),
    sendAttachment: vi.fn(async () => ({ id: nextId++, roomId: 221 })),
  } as unknown as SabhaClient;
  const runtime = {
    channel: { media: { readRemoteMediaBuffer: vi.fn(async () => ({ buffer: Buffer.from("png"), contentType: "image/png", fileName: "a.png" })) } },
  } as never;
  const draft = options.withDraft === false
    ? undefined
    : createSabhaDraft({ perform: (frame) => (frames.push(frame), true), target, newId: () => "draft-1" });
  const delivery = createSabhaReplyDelivery({ client, runtime, account, target, ...(draft ? { draft } : {}) });
  return { delivery, frames, posts, client };
}

describe("createSabhaReplyDelivery", () => {
  it("replaces the live draft with the final message", async () => {
    const { delivery, frames, posts } = setup();
    delivery.onPartialReply({ text: "Work" });
    const result = await delivery.deliver({ text: "Working on it." }, { kind: "final" });
    expect(posts).toEqual([{ roomId: 3, text: "Working on it.", options: { parentMessageId: 4214, clientMessageId: "draft-1" } }]);
    expect(result).toMatchObject({ visibleReplySent: true, messageIds: ["900"] });
    await delivery.finish();
    expect(frames.map((frame) => frame.kind)).not.toContain("end");
  });

  it("posts normally and ends the draft when the final carries media", async () => {
    const { delivery, frames, posts, client } = setup();
    delivery.onPartialReply({ text: "Here" });
    await delivery.deliver({ text: "Here you go", mediaUrls: ["https://cdn.test/a.png"] }, { kind: "final" });
    await delivery.finish();
    expect(posts[0]!.options).toEqual({ parentMessageId: 4214 });
    expect(client.sendAttachment).toHaveBeenCalledOnce();
    expect(frames.at(-1)?.kind).toBe("end");
  });

  it("ends the draft when the turn produced nothing or failed", async () => {
    for (const failed of [false, true]) {
      const { delivery, frames } = setup();
      delivery.onPartialReply({ text: "Thinking" });
      await delivery.finish({ failed });
      expect(frames.at(-1)?.kind).toBe("end");
    }
  });

  it("posts without a draft id when previews are off", async () => {
    const { delivery, posts } = setup({ withDraft: false });
    await delivery.deliver({ text: "Hi" }, { kind: "final" });
    expect(posts[0]!.options).toEqual({ parentMessageId: 4214 });
  });

  it("does not repost a final whose first chunk already landed", async () => {
    const { delivery, posts } = setup({ failSendAt: 1 });
    delivery.onPartialReply({ text: "x" });
    const long = `${"a".repeat(11_000)}\n\n${"b".repeat(11_000)}`;
    await expect(delivery.deliver({ text: long }, { kind: "final" })).rejects.toThrow();
    expect(posts).toHaveLength(1);
  });

  it("reports only the chunks that landed when a later chunk fails", async () => {
    const { delivery } = setup({ withDraft: false, failSendAt: 1 });
    const first = "a".repeat(11_000);
    const error = await delivery.deliver({ text: `${first}\n\n${"b".repeat(11_000)}` }, { kind: "final" }).catch((caught: unknown) => caught);
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    const result = (error as { deliveryResult: { content: string; messageIds: string[] } }).deliveryResult;
    expect(result.messageIds).toEqual(["900"]);
    expect(result.content).toBe(first);
  });

  it("skips reasoning payloads", async () => {
    const { delivery, posts } = setup();
    await expect(delivery.deliver({ text: "hmm", isReasoning: true }, { kind: "block" })).resolves.toMatchObject({ visibleReplySent: false });
    expect(posts).toEqual([]);
  });
});
