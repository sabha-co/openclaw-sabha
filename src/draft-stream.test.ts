import { describe, it, expect, vi } from "vitest";
import { createSabhaDraftStream, formatStreamError } from "./draft-stream.js";
import { SabhaApiError } from "./client.js";
import type { SabhaClient } from "./client.js";

/**
 * Tests avoid fake timers and drive the loop by calling `flush()`
 * explicitly after each `update(...)`. The SDK's throttle math is
 * covered by the SDK's own tests — what we verify here is Sabha's
 * `sendOrEditStreamMessage` callback: first send, subsequent edits,
 * dedup, error handling, `clear`, `forceNewMessage`.
 */

function makeStubClient(overrides: Partial<SabhaClient> = {}): {
  client: SabhaClient;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(42);
  const editMessage = vi
    .fn()
    .mockResolvedValue({ html: "", plain: "" });
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const client = {
    sendMessage,
    editMessage,
    deleteMessage,
    ...overrides,
  } as unknown as SabhaClient;
  return { client, sendMessage, editMessage, deleteMessage };
}

describe("createSabhaDraftStream", () => {
  it("sends a new message on first flushed update", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(10, "hello");
    expect(editMessage).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe(42);
  });

  it("edits the same message on subsequent updates", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();
    stream.update("hello world again");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(editMessage).toHaveBeenNthCalledWith(1, 10, 42, "hello world");
    expect(editMessage).toHaveBeenNthCalledWith(2, 10, 42, "hello world again");
  });

  it("deduplicates identical snapshots", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello");
    await stream.flush();
    stream.update("hello");
    await stream.flush();
    stream.update("hello");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("trims trailing whitespace before sending", async () => {
    const { client, sendMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello   \n");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledWith(10, "hello");
  });

  it("skips empty updates", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("   \n\n");
    await stream.flush();
    stream.update("");
    await stream.flush();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();
  });

  it("stops the stream when the send fails", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    sendMessage.mockReset().mockRejectedValue(new Error("network down"));
    const warn = vi.fn();
    const stream = createSabhaDraftStream({
      client,
      roomId: 10,
      logger: { warn },
    });

    stream.update("hello");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("network down"));

    // Subsequent updates must be no-ops because the stream is stopped.
    stream.update("hello world");
    await stream.flush();
    expect(editMessage).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();
  });

  it("stops the stream when sendMessage returns null", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    sendMessage.mockReset().mockResolvedValue(null);
    const warn = vi.fn();
    const stream = createSabhaDraftStream({
      client,
      roomId: 10,
      logger: { warn },
    });

    stream.update("hello");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sendMessage returned no id"),
    );

    stream.update("hello world");
    await stream.flush();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("stops the stream when text exceeds maxChars", async () => {
    const { client, sendMessage } = makeStubClient();
    const warn = vi.fn();
    const stream = createSabhaDraftStream({
      client,
      roomId: 10,
      maxChars: 20,
      logger: { warn },
    });

    stream.update("x".repeat(21));
    await stream.flush();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("> 20"));
  });

  it("deletes the preview message on clear", async () => {
    const { client, deleteMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello");
    await stream.flush();
    expect(stream.messageId()).toBe(42);

    await stream.clear();

    expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(10, 42);
    expect(stream.messageId()).toBeUndefined();
  });

  it("does not call deleteMessage when no preview exists", async () => {
    const { client, deleteMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    await stream.clear();

    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("flushes the latest text on stop", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello");
    await stream.flush();
    // Subsequent update with no explicit flush — `stop` must still send it.
    stream.update("hello world (final)");
    await stream.stop();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledExactlyOnceWith(
      10,
      42,
      "hello world (final)",
    );
  });

  it("forceNewMessage resets so the next update sends a fresh message", async () => {
    const { client, sendMessage } = makeStubClient();
    sendMessage
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(43);
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("first");
    await stream.flush();
    expect(stream.messageId()).toBe(42);

    stream.forceNewMessage();
    expect(stream.messageId()).toBeUndefined();

    stream.update("second");
    await stream.flush();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 10, "first");
    expect(sendMessage).toHaveBeenNthCalledWith(2, 10, "second");
    expect(stream.messageId()).toBe(43);
  });

  it("stop() with no pending text does not re-send the last snapshot", async () => {
    const { client, sendMessage, editMessage } = makeStubClient();
    const stream = createSabhaDraftStream({ client, roomId: 10 });

    stream.update("hello");
    await stream.flush();
    await stream.stop();

    // Exactly one send, zero edits — stop without pending changes is a no-op.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).not.toHaveBeenCalled();
  });

  describe("isAlive", () => {
    it("starts alive", () => {
      const { client } = makeStubClient();
      const stream = createSabhaDraftStream({ client, roomId: 10 });
      expect(stream.isAlive()).toBe(true);
    });

    it("flips to false after a send failure", async () => {
      const { client, sendMessage } = makeStubClient();
      sendMessage.mockReset().mockRejectedValue(new Error("network down"));
      const stream = createSabhaDraftStream({
        client,
        roomId: 10,
        logger: { warn: vi.fn() },
      });

      stream.update("hello");
      await stream.flush();

      expect(stream.isAlive()).toBe(false);
    });

    it("flips to false after an edit failure mid-stream", async () => {
      const { client, editMessage } = makeStubClient();
      editMessage.mockReset().mockRejectedValueOnce(new Error("edit 500"));
      const stream = createSabhaDraftStream({
        client,
        roomId: 10,
        logger: { warn: vi.fn() },
      });

      stream.update("hello");
      await stream.flush();
      expect(stream.isAlive()).toBe(true);

      stream.update("hello world");
      await stream.flush();

      expect(stream.isAlive()).toBe(false);
      // Preview message id remains visible so the caller can recover
      // via direct editMessage — this is the contract that monitor.ts
      // and index.ts depend on.
      expect(stream.messageId()).toBe(42);
    });

    it("flips to false when the max-chars cap is exceeded", async () => {
      const { client } = makeStubClient();
      const stream = createSabhaDraftStream({
        client,
        roomId: 10,
        maxChars: 5,
        logger: { warn: vi.fn() },
      });

      stream.update("too long");
      await stream.flush();

      expect(stream.isAlive()).toBe(false);
    });
  });

});

describe("formatStreamError", () => {
  it("returns the error message for Error instances", () => {
    expect(formatStreamError(new Error("something broke"))).toBe(
      "something broke",
    );
  });

  it("coerces non-Error throwables", () => {
    expect(formatStreamError("string thrown")).toBe("string thrown");
    expect(formatStreamError(42)).toBe("42");
    expect(formatStreamError(null)).toBe("null");
  });

  it("redacts bot keys from SabhaApiError messages", () => {
    // This is the core P0 fix: `SabhaApiError`'s super constructor
    // interpolates the fetch URL into the error message, and
    // `SabhaClient` embeds the bot_key in the URL path. Without
    // redaction, a failing request would leak the bot_key into any
    // user-visible error surface (Q12 error-replace in particular).
    const err = new SabhaApiError(
      500,
      "internal",
      "https://sabha.example.com/rooms/5/42-AbCdEfGhIjKlMnOp/messages",
    );
    const safe = formatStreamError(err);
    expect(safe).not.toContain("42-AbCdEfGhIjKlMnOp");
    expect(safe).toContain("***");
    // Non-secret context should survive redaction.
    expect(safe).toContain("500");
    expect(safe).toContain("internal");
  });

  it("redacts bot keys from anywhere in the message", () => {
    const err = new Error(
      "prefix 123-AbCdEfGhIjKlMnOpQr middle 99-xyzXYZ0123ABCDEF suffix",
    );
    const safe = formatStreamError(err);
    expect(safe).not.toContain("123-AbCdEfGhIjKlMnOpQr");
    expect(safe).not.toContain("99-xyzXYZ0123ABCDEF");
    expect(safe).toMatch(/prefix \*\*\* middle \*\*\* suffix/);
  });

  it("does not over-redact short numeric-dash patterns", () => {
    // Commit hashes, timestamps, and short identifiers with a numeric
    // prefix should survive. The regex requires a {10,}-char token
    // after the dash, so `1-abc` and `42-xyz` are safe.
    expect(formatStreamError(new Error("commit 1-abc"))).toContain("1-abc");
    expect(formatStreamError(new Error("port 8080-local"))).toContain(
      "8080-local",
    );
  });

  it("truncates messages longer than 500 chars", () => {
    const long = "x".repeat(1000);
    const safe = formatStreamError(new Error(long));
    expect(safe.length).toBe(501); // 500 chars + ellipsis
    expect(safe.endsWith("…")).toBe(true);
  });
});
