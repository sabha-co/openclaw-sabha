import { describe, expect, it, vi } from "vitest";
import type { SabhaClient } from "./client.js";
import { createSabhaDraftStream } from "./draft-stream.js";
import { deliverSabhaPayload, finalizeSabhaReply } from "./delivery.js";
import { resolveSabhaAccount } from "./accounts.js";
import { fetchGuardedAttachment } from "./ssrf-guard.js";
vi.mock("./ssrf-guard.js", () => ({ fetchGuardedAttachment: vi.fn() }));

function fixture() {
  const client = { sendMessage: vi.fn().mockResolvedValue({ id: 12, roomId: 99 }), editMessage: vi.fn().mockResolvedValue(undefined), deleteMessage: vi.fn().mockResolvedValue(undefined) };
  const draft = createSabhaDraftStream({ client: client as unknown as SabhaClient, roomId: 5, parentMessageId: 10 });
  const finalize = (text: string) => finalizeSabhaReply({ client: client as unknown as SabhaClient, draft, text, roomId: 5, parentMessageId: 10 });
  return { client, draft, finalize };
}

describe("provider delivery settlement", () => {
  it("waits for a pending first preview and returns its resolved room receipt", async () => {
    const f = fixture();
    let release!: (result: { id: number; roomId: number }) => void;
    f.client.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    f.draft.update("Partial reply");
    const pending = f.draft.flush();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const final = f.finalize("Final reply");
    release({ id: 12, roomId: 99 });
    await pending;
    expect(await final).toMatchObject({ messageIds: ["12"], visibleReplySent: true, receipt: { raw: [{ roomId: "99" }] } });
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
    expect(f.client.editMessage).toHaveBeenLastCalledWith(12, "Final reply");
  });
  it("does not claim success or send again after an ambiguous first send", async () => {
    const f = fixture();
    f.client.sendMessage.mockResolvedValue(null);
    await expect(f.finalize("Final")).rejects.toThrow("no message receipt");
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
  });
  it("repairs a failed preview edit before reporting the final receipt", async () => {
    const f = fixture();
    f.draft.update("Partial"); await f.draft.flush();
    f.client.editMessage.mockRejectedValueOnce(new Error("transient"));
    expect(await f.finalize("Final")).toMatchObject({ visibleReplySent: true, messageIds: ["12"] });
    expect(f.client.editMessage).toHaveBeenCalledTimes(2);
  });
  it("does not replace a preview when its deletion fails", async () => {
    const f = fixture();
    f.draft.update("Partial"); await f.draft.flush();
    f.client.editMessage.mockRejectedValue(new Error("edit failed"));
    f.client.deleteMessage.mockRejectedValue(new Error("delete failed"));
    await expect(f.finalize("Final")).rejects.toThrow("delete failed");
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
  });
  it("reports empty payload as suppressed without a platform call", async () => {
    const f = fixture();
    expect(await f.finalize(" ")).toMatchObject({ visibleReplySent: false, suppression: { reason: "no_visible_result" } });
    expect(f.client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("attachment delivery settlement", () => {
  const account = resolveSabhaAccount({ cfg: {} });
  it("sends media-only output in the reply thread with a real receipt", async () => {
    vi.mocked(fetchGuardedAttachment).mockResolvedValue({ buffer: Buffer.from("image"), fileName: "image.png" });
    const f = fixture();
    const client = { ...f.client, sendAttachment: vi.fn().mockResolvedValue({ id: 13, roomId: 99 }) };
    const result = await deliverSabhaPayload({ client: client as unknown as SabhaClient, account, draft: f.draft,
      text: "", mediaUrls: ["https://example/image.png"], roomId: 5, parentMessageId: 10 });
    expect(result).toMatchObject({ visibleReplySent: true, messageIds: ["13"], receipt: { raw: [{ roomId: "99" }] } });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendAttachment).toHaveBeenCalledWith(5, expect.any(Blob), "image.png", { parentMessageId: 10 });
  });
  it("retains the text receipt when a later attachment fails", async () => {
    vi.mocked(fetchGuardedAttachment).mockRejectedValue(new Error("blocked URL"));
    const f = fixture();
    await expect(deliverSabhaPayload({ client: f.client as unknown as SabhaClient, account, draft: f.draft,
      text: "Final", mediaUrls: ["http://private/image"], roomId: 5 })).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY", deliveryResult: { visibleReplySent: true, messageIds: ["12"] },
    });
    expect(f.client.deleteMessage).not.toHaveBeenCalled();
  });
});
