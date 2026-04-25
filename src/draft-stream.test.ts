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

  it("update + stop coalesces when a partial send is still in flight (regression)", async () => {
    // Regression for the P1 race flagged by the second review pass:
    //
    // 1. A fast model emits a partial → `update("Hel")` → SDK schedules
    //    a flush → `client.sendMessage("Hel")` starts (slow Sabha API).
    // 2. Before the send resolves, the runtime finalizes the turn and
    //    the caller tries to finalize via the streaming fast-path.
    // 3. At the moment of the fast-path check, `messageId()` is still
    //    `undefined` (the in-flight send hasn't written it yet).
    //
    // The old gate was `messageId() !== undefined`, which meant the
    // caller fell through to `client.sendMessage(finalText)` and the
    // user saw TWO messages: the partial preview that eventually landed
    // PLUS a fresh "final" reply. The fix gates on `isAlive()` instead
    // and relies on `stop()` to drain the in-flight via `inFlightPromise`
    // before sending the final edit.
    //
    // This test anchors the SDK-level invariant: `update(final) + stop()`
    // while a partial send is pending must result in exactly one
    // observable preview message containing the final text — no second
    // send, no stale partial.
    const { client, sendMessage, editMessage } = makeStubClient();
    let resolveFirstSend: (id: number | null) => void = () => {};
    const firstSendPromise = new Promise<number | null>((resolve) => {
      resolveFirstSend = resolve;
    });
    sendMessage.mockReset().mockReturnValueOnce(firstSendPromise);

    const stream = createSabhaDraftStream({ client, roomId: 10 });

    // Partial arrives. This kicks off `sendMessage("Hel")` which is
    // now pending on `firstSendPromise`.
    stream.update("Hel");
    // Let the microtask queue run so the SDK loop actually starts the send.
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(10, "Hel");
    // Still no messageId — that's the race window the old gate missed.
    expect(stream.messageId()).toBeUndefined();
    // But the stream is still alive, which is what the new gate uses.
    expect(stream.isAlive()).toBe(true);

    // Runtime finalizes. Caller updates with the full text and stops.
    stream.update("Hello world");
    const stopPromise = stream.stop();

    // stop() is waiting on `inFlightPromise`. Resolve the partial send.
    resolveFirstSend(42);
    await stopPromise;

    // Exactly one send (the partial), exactly one edit (the final text),
    // exactly one preview message. No double-post.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledExactlyOnceWith(10, 42, "Hello world");
    expect(stream.messageId()).toBe(42);
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
    // Defense-in-depth. Since the bearer-auth refactor the bot_key
    // is carried in the Authorization header, not the URL path, so
    // `SabhaApiError.url` no longer interpolates the key — but the
    // redactor stays as a belt-and-suspenders guard for any future
    // leak vector (operator logs, manually-constructed errors,
    // third-party code paths).
    const err = new SabhaApiError(
      500,
      "internal",
      "https://sabha.example.com/api/bots/rooms/5/messages 42-AbCdEfGhIjKlMnOp",
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
