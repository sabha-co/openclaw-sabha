import { describe, it, expect, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import {
  buildDedupKey,
  buildWebSocketUrl,
  isSelfEchoEvent,
  monitorSabha,
} from "./monitor.js";
import type { ResolvedSabhaAccount } from "./accounts.js";
import type {
  SabhaBoostCreatedPayload,
  SabhaMessageCreatedPayload,
  SabhaMessageDeletedPayload,
  SabhaMessageUpdatedPayload,
  SabhaUserCreatedPayload,
  SabhaWebhookMessage,
  SabhaWebhookRoom,
  SabhaWebhookUser,
} from "./types.js";

describe("buildWebSocketUrl", () => {
  it("converts http to ws and appends /cable", () => {
    const url = buildWebSocketUrl("http://localhost:3000", "42-abc");
    expect(url).toBe("ws://localhost:3000/cable?bot_key=42-abc");
  });

  it("converts https to wss", () => {
    const url = buildWebSocketUrl("https://chat.example.com", "42-abc");
    expect(url).toBe("wss://chat.example.com/cable?bot_key=42-abc");
  });

  it("includes workspace ID as wid for multi-tenant URLs", () => {
    const url = buildWebSocketUrl("http://localhost:3000/1000006", "42-abc");
    expect(url).toBe("ws://localhost:3000/cable?bot_key=42-abc&wid=1000006");
  });

  it("includes wid for production multi-tenant URLs", () => {
    const url = buildWebSocketUrl("https://sabha.co/1000006", "42-abc");
    expect(url).toBe("wss://sabha.co/cable?bot_key=42-abc&wid=1000006");
  });

  it("uses websocketUrl when provided", () => {
    const url = buildWebSocketUrl(
      "http://localhost:3000",
      "42-abc",
      "ws://custom:8080/cable?bot_key=42-abc",
    );
    expect(url).toBe("ws://custom:8080/cable?bot_key=42-abc");
  });
});

describe("monitorSabha — logging", () => {
  // Minimal ResolvedSabhaAccount stub. We only exercise the boot + log path
  // (aborted signal short-circuits runWithReconnect before a socket opens),
  // so most runtime fields can be defaults.
  function stubAccount(
    overrides: Partial<ResolvedSabhaAccount> = {},
  ): ResolvedSabhaAccount {
    return {
      accountId: "default",
      enabled: true,
      baseUrl: "http://localhost:3000",
      apiBaseUrl: "http://localhost:3000/api/bots",
      botKey: "42-abc",
      webhookSecret: "whsec_test",
      botId: 42,
      botName: "TestBot",
      webhookPort: 8787,
      connectionMode: "websocket",
      websocketUrl: "",
      typingEnabled: false,
      dmPolicy: "open",
      allowFrom: [],
      allowPrivateAttachmentHosts: false,
      replyToMode: "first",
      rooms: {},
      ...overrides,
    };
  }

  // Runtime is only used by processInboundMessage (which isn't reached
  // when the monitor exits on an already-aborted signal), so a typed empty
  // stub is safe.
  const stubRuntime = {} as unknown as PluginRuntime;

  async function runWithAbortedSignal(
    account: ResolvedSabhaAccount,
    logger: { info: (msg: string) => void; error: (msg: string) => void },
  ) {
    const controller = new AbortController();
    controller.abort();
    await monitorSabha({
      account,
      config: { channels: { sabha: {} } } as never,
      runtime: stubRuntime,
      abortSignal: controller.signal,
      logger,
    });
  }

  it("includes the bot account id in the connect log line for the default account", async () => {
    const info = vi.fn();
    const error = vi.fn();
    await runWithAbortedSignal(stubAccount(), { info, error });
    expect(
      info.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.startsWith("[sabha:default] Connecting"),
      ),
    ).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("uses the named bot account id when running under a non-default account", async () => {
    const info = vi.fn();
    await runWithAbortedSignal(
      stubAccount({ accountId: "staging", botKey: "99-stg" }),
      { info, error: vi.fn() },
    );
    expect(
      info.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.startsWith("[sabha:staging] Connecting"),
      ),
    ).toBe(true);
  });

  it("redacts the bot_key query parameter in the connect log", async () => {
    const info = vi.fn();
    await runWithAbortedSignal(
      stubAccount({ botKey: "42-SecretKey" }),
      { info, error: vi.fn() },
    );
    const connectLine = info.mock.calls
      .map(([msg]) => (typeof msg === "string" ? msg : ""))
      .find((msg) => msg.includes("Connecting"));
    expect(connectLine).toBeDefined();
    expect(connectLine).toContain("bot_key=***");
    expect(connectLine).not.toContain("42-SecretKey");
  });
});

// ---------------------------------------------------------------------------
// buildDedupKey + isSelfEchoEvent
// ---------------------------------------------------------------------------
//
// Regression coverage for the dedup/self-echo cleanup that landed in 0.9.3.
// Two concrete bugs caught during 0.9.2 streaming manual test:
//
//  1. `message_updated:<id>` collapsed every edit of the same message id
//     into one dedup slot. Bot self-edits during streaming filled the slot
//     on the first echo, then every subsequent edit logged "Skipping
//     duplicate message_updated:14" at info level — ~12 log lines per
//     streaming turn. A real user editing their own message twice within
//     5 minutes would have had the second edit silently dropped.
//
//  2. The self-echo filter only ran inside the per-handler path
//     (`shouldHandleInbound` in src/inbound.ts), so bot self-echoes
//     polluted the dedup cache before they were dropped. Moving the
//     self-filter ahead of dedup short-circuits all of that.

function stubUser(overrides: Partial<SabhaWebhookUser> = {}): SabhaWebhookUser {
  return {
    id: 7,
    name: "Alice",
    role: "member",
    url: "http://localhost:3000/users/7",
    ...overrides,
  };
}

function stubRoom(overrides: Partial<SabhaWebhookRoom> = {}): SabhaWebhookRoom {
  return {
    id: 1,
    name: "General",
    type: "Open",
    members: 5,
    has_bot: true,
    messages_url: "http://localhost:3000/rooms/1/messages",
    ...overrides,
  };
}

function stubMessage(
  overrides: Partial<SabhaWebhookMessage> = {},
): SabhaWebhookMessage {
  return {
    id: 14,
    body: { html: "<p>hi</p>", plain: "hi" },
    has_attachment: false,
    attachment: null,
    mentionees: [],
    url: "http://localhost:3000/rooms/1/messages/14",
    created_at: "2026-04-12T19:09:19Z",
    updated_at: "2026-04-12T19:09:19Z",
    thread: null,
    ...overrides,
  };
}

describe("buildDedupKey", () => {
  it("scopes keys by event so the same numeric id across variants never collides", () => {
    const created: SabhaMessageCreatedPayload = {
      event: "message_created",
      user: stubUser(),
      room: stubRoom(),
      message: stubMessage({ id: 42 }),
    };
    const updated: SabhaMessageUpdatedPayload = {
      event: "message_updated",
      user: stubUser(),
      room: stubRoom(),
      message: stubMessage({ id: 42, updated_at: "2026-04-12T19:09:20Z" }),
    };
    const deleted: SabhaMessageDeletedPayload = {
      event: "message_deleted",
      user: stubUser(),
      room: stubRoom(),
      message: stubMessage({ id: 42 }),
    };
    const keys = new Set([
      buildDedupKey(created),
      buildDedupKey(updated),
      buildDedupKey(deleted),
    ]);
    expect(keys.size).toBe(3);
  });

  it("includes updated_at in the message_updated key so repeat edits of the same message id are distinct events", () => {
    // The root cause of the ~12-per-turn "Skipping duplicate
    // message_updated:14" log spam in 0.9.2 — every edit of message
    // id 14 hashed to the same key and collapsed into one dedup slot.
    const firstEdit: SabhaMessageUpdatedPayload = {
      event: "message_updated",
      user: stubUser(),
      room: stubRoom(),
      message: stubMessage({ updated_at: "2026-04-12T19:09:27.100Z" }),
    };
    const secondEdit: SabhaMessageUpdatedPayload = {
      event: "message_updated",
      user: stubUser(),
      room: stubRoom(),
      message: stubMessage({ updated_at: "2026-04-12T19:09:27.900Z" }),
    };
    expect(buildDedupKey(firstEdit)).not.toBe(buildDedupKey(secondEdit));
  });

  it("still collapses a true duplicate (same id, same updated_at) into one key — reconnect replay must dedup", () => {
    // A genuine duplicate from WebSocket reconnect replay — Sabha
    // resends the exact same frame — must still hash to the same
    // key so the dedup cache can catch it. The tiebreaker only
    // differentiates *distinct* edits, not identical replays.
    const replay: SabhaMessageUpdatedPayload = {
      event: "message_updated",
      user: stubUser(),
      room: stubRoom(),
      message: stubMessage({ updated_at: "2026-04-12T19:09:27.100Z" }),
    };
    expect(buildDedupKey(replay)).toBe(buildDedupKey({ ...replay }));
  });

  it("returns null for user_* variants so they bypass the cache", () => {
    const userCreated: SabhaUserCreatedPayload = {
      event: "user_created",
      user: stubUser(),
    };
    expect(buildDedupKey(userCreated)).toBeNull();
  });
});

describe("isSelfEchoEvent", () => {
  it("drops message_created from the bot itself", () => {
    const payload: SabhaMessageCreatedPayload = {
      event: "message_created",
      user: stubUser({ id: 42 }),
      room: stubRoom(),
      message: stubMessage(),
    };
    expect(isSelfEchoEvent(payload, 42)).toBe(true);
  });

  it("drops message_updated echoes from the bot's own edits during streaming", () => {
    // The central case: streaming means the bot calls editMessage many
    // times per turn, and Sabha fans every edit back to the bot as
    // `message_updated` (Scout A, hazard #2). Without this short-circuit
    // each echo would hit dedup/log before the per-handler filter drops it.
    const payload: SabhaMessageUpdatedPayload = {
      event: "message_updated",
      user: stubUser({ id: 42 }),
      room: stubRoom(),
      message: stubMessage({ updated_at: "2026-04-12T19:09:27.100Z" }),
    };
    expect(isSelfEchoEvent(payload, 42)).toBe(true);
  });

  it("drops message_deleted echoes from the bot's own deletes", () => {
    const payload: SabhaMessageDeletedPayload = {
      event: "message_deleted",
      user: stubUser({ id: 42 }),
      room: stubRoom(),
      message: stubMessage(),
    };
    expect(isSelfEchoEvent(payload, 42)).toBe(true);
  });

  it("drops boost_created echoes from the bot's own reactions", () => {
    const payload: SabhaBoostCreatedPayload = {
      event: "boost_created",
      user: stubUser({ id: 42 }),
      room: stubRoom(),
      message: stubMessage(),
      boost: { id: 99, body: "👍" },
    };
    expect(isSelfEchoEvent(payload, 42)).toBe(true);
  });

  it("passes through events from other users", () => {
    const payload: SabhaMessageCreatedPayload = {
      event: "message_created",
      user: stubUser({ id: 7 }),
      room: stubRoom(),
      message: stubMessage(),
    };
    expect(isSelfEchoEvent(payload, 42)).toBe(false);
  });

  it("passes through user_* events even if the subject happens to share the bot id — these are never bot-originated", () => {
    // `user_created` fires when a workspace member is created. Sabha
    // never fires this as a result of a bot action, so the self-echo
    // concept does not apply.
    const payload: SabhaUserCreatedPayload = {
      event: "user_created",
      user: stubUser({ id: 42 }),
    };
    expect(isSelfEchoEvent(payload, 42)).toBe(false);
  });
});
