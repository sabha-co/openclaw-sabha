import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processInboundMessage,
  shouldHandleInbound,
  handleMessageUpdated,
  handleMessageDeleted,
  handleBoostCreated,
  handleBoostDeleted,
  handleUserCreated,
  handleUserDeleted,
} from "./inbound.js";
import type {
  SabhaMessageCreatedPayload,
  SabhaMessageUpdatedPayload,
  SabhaMessageDeletedPayload,
  SabhaBoostCreatedPayload,
  SabhaBoostDeletedPayload,
  SabhaUserCreatedPayload,
  SabhaUserDeletedPayload,
  SabhaAccount,
} from "./types.js";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";

// We stub dispatchInboundReplyWithBase to capture ctxPayload without
// needing the full OpenClaw runtime machinery.
vi.mock("openclaw/plugin-sdk/inbound-reply-dispatch", () => ({
  dispatchInboundReplyWithBase: vi.fn(),
}));

import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";

const mockDispatch = dispatchInboundReplyWithBase as ReturnType<typeof vi.fn>;

function makeChannelRuntime(): PluginRuntime["channel"] {
  return {
    routing: {
      resolveAgentRoute: vi.fn().mockReturnValue({
        agentId: "agent-default",
        sessionKey: "sabha:group:5",
        accountId: "default",
      }),
    },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/sabha-store"),
    },
    media: {
      fetchRemoteMedia: vi.fn(),
      saveMediaBuffer: vi.fn(),
    },
    reply: {
      resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
      formatAgentEnvelope: vi.fn(({ body, from }) => `[${from}]: ${body}`),
      // Pass-through — the contract test inspects what we pass in
      finalizeInboundContext: vi.fn((ctx) => ctx),
    },
  } as unknown as PluginRuntime["channel"];
}

const baseAccount: SabhaAccount = {
  accountId: "default",
  baseUrl: "https://sabha.co/1000006",
  botKey: "42-AbCdEfGhIjKl",
  botId: 42,
  webhookPort: 8787,
  connectionMode: "websocket",
  websocketUrl: "",
  dmPolicy: "open",
  allowFrom: [],
};

const baseCfg = { channels: { sabha: {} } } as unknown as OpenClawConfig;

function makePayload(
  overrides: Partial<SabhaMessageCreatedPayload> = {},
): SabhaMessageCreatedPayload {
  return {
    event: "message_created",
    user: {
      id: 1,
      name: "Alice",
      role: "member",
      url: "https://sabha.co/1000006/users/1",
    },
    room: {
      id: 5,
      name: "General",
      type: "Open",
      members: 12,
      has_bot: true,
      messages_url: "https://sabha.co/1000006/rooms/5/42-AbCdEfGhIjKl/messages",
    },
    message: {
      id: 10,
      body: { html: "<p>Hello @MyBot</p>", plain: "Hello @MyBot" },
      has_attachment: false,
      attachment: null,
      mentionees: [{ id: 42, name: "MyBot" }],
      url: "https://sabha.co/1000006/rooms/5@10",
      created_at: "2026-04-07T12:00:00Z",
      updated_at: "2026-04-07T12:00:00Z",
      thread: null,
    },
    ...overrides,
  };
}

describe("processInboundMessage", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
  });

  it("skips messages from the bot itself", async () => {
    const payload = makePayload({
      user: { id: 42, name: "MyBot", role: "bot", url: "" },
    });
    await processInboundMessage(payload, {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("skips group messages without a bot mention", async () => {
    const payload = makePayload({
      message: {
        ...makePayload().message,
        mentionees: [],
      },
    });
    await processInboundMessage(payload, {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("always processes DM messages regardless of mention", async () => {
    const payload = makePayload({
      room: { ...makePayload().room, type: "Direct" },
      message: { ...makePayload().message, mentionees: [] },
    });
    await processInboundMessage(payload, {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("builds ctxPayload with PascalCase field names", async () => {
    await processInboundMessage(makePayload(), {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
    const dispatchCall = mockDispatch.mock.calls[0][0] as { ctxPayload: Record<string, unknown> };
    const ctx = dispatchCall.ctxPayload;

    // These are the PascalCase fields the SDK's MsgContext requires.
    // This test catches the regression where we used camelCase and got an empty LLM prompt.
    expect(ctx.Body).toBeDefined();
    expect(typeof ctx.Body).toBe("string");
    expect(ctx.BodyForAgent).toBeDefined();
    expect(ctx.RawBody).toBe("Hello @MyBot");
    expect(ctx.CommandBody).toBe("Hello @MyBot");
    expect(ctx.BodyForCommands).toBe("Hello @MyBot");
    expect(ctx.From).toBe("Alice");
    expect(ctx.SenderId).toBe("1");
    expect(ctx.SenderName).toBe("Alice");
    expect(ctx.To).toBe("5");
    expect(ctx.SessionKey).toBe("sabha:group:5");
    expect(ctx.AccountId).toBe("default");
    expect(ctx.ChatType).toBe("group");
    expect(ctx.ConversationLabel).toBe("General");
    expect(ctx.MessageSid).toBe("10");
    expect(typeof ctx.Timestamp).toBe("number");
  });

  it("maps Direct room type to direct ChatType", async () => {
    const payload = makePayload({
      room: { ...makePayload().room, type: "Direct" },
    });
    await processInboundMessage(payload, {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });

    const ctx = (mockDispatch.mock.calls[0][0] as { ctxPayload: { ChatType: string } }).ctxPayload;
    expect(ctx.ChatType).toBe("direct");
  });

  it("includes ReplyToId for threaded messages", async () => {
    const payload = makePayload({
      message: {
        ...makePayload().message,
        thread: { id: 99, parent_message_id: 10 },
      },
    });
    await processInboundMessage(payload, {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });

    const ctx = (mockDispatch.mock.calls[0][0] as { ctxPayload: { ReplyToId?: string } }).ctxPayload;
    expect(ctx.ReplyToId).toBe("99");
  });

  it("passes the normalized channel runtime to dispatch", async () => {
    await processInboundMessage(makePayload(), {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });

    const call = mockDispatch.mock.calls[0][0] as { channel: string; core: { channel: unknown } };
    expect(call.channel).toBe("sabha");
    expect(call.core.channel).toBeDefined();
  });

  it("threads onPartialReply through replyOptions when provided", async () => {
    const onPartialReply = vi.fn();
    await processInboundMessage(makePayload(), {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
      onPartialReply,
    });

    const call = mockDispatch.mock.calls[0][0] as {
      replyOptions?: { onPartialReply?: unknown };
    };
    expect(call.replyOptions?.onPartialReply).toBe(onPartialReply);
  });

  it("omits replyOptions entirely when onPartialReply is not provided", async () => {
    await processInboundMessage(makePayload(), {
      runtime: makeChannelRuntime(),
      cfg: baseCfg,
      account: baseAccount,
      deliver: vi.fn(),
    });

    const call = mockDispatch.mock.calls[0][0] as {
      replyOptions?: unknown;
    };
    expect(call.replyOptions).toBeUndefined();
  });
});

describe("shouldHandleInbound", () => {
  it("returns false for the bot's own messages", () => {
    const payload = makePayload({
      user: { id: 42, name: "MyBot", role: "bot", url: "" },
    });
    expect(shouldHandleInbound(payload, 42)).toBe(false);
  });

  it("returns false for group messages without a bot mention", () => {
    const payload = makePayload({
      message: { ...makePayload().message, mentionees: [] },
    });
    expect(shouldHandleInbound(payload, 42)).toBe(false);
  });

  it("returns true for group messages that mention the bot", () => {
    expect(shouldHandleInbound(makePayload(), 42)).toBe(true);
  });

  it("returns true for DMs regardless of mention", () => {
    const payload = makePayload({
      room: { ...makePayload().room, type: "Direct" },
      message: { ...makePayload().message, mentionees: [] },
    });
    expect(shouldHandleInbound(payload, 42)).toBe(true);
  });

  it("extends the self-echo filter to message_updated", () => {
    // Bot edits its own message via Messages::ByBotsController#update;
    // the WebSocket fan-out echoes it back to every eligible member
    // including the bot itself. Must be filtered out the same way
    // message_created is.
    const payload: SabhaMessageUpdatedPayload = {
      ...makePayload(),
      event: "message_updated",
      user: { id: 42, name: "MyBot", role: "bot", url: "" },
    };
    expect(shouldHandleInbound(payload, 42)).toBe(false);
  });

  it("extends the self-echo filter to message_deleted", () => {
    const payload: SabhaMessageDeletedPayload = {
      ...makePayload(),
      event: "message_deleted",
      user: { id: 42, name: "MyBot", role: "bot", url: "" },
    };
    expect(shouldHandleInbound(payload, 42)).toBe(false);
  });
});

describe("handleMessageUpdated", () => {
  it("logs at info level when the event is in scope", async () => {
    const info = vi.fn();
    const payload: SabhaMessageUpdatedPayload = {
      ...makePayload(),
      event: "message_updated",
    };
    await handleMessageUpdated(payload, { botId: 42, logger: { info } });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("message_updated"),
    );
  });

  it("is silent for self-echo", async () => {
    const info = vi.fn();
    const payload: SabhaMessageUpdatedPayload = {
      ...makePayload(),
      event: "message_updated",
      user: { id: 42, name: "MyBot", role: "bot", url: "" },
    };
    await handleMessageUpdated(payload, { botId: 42, logger: { info } });
    expect(info).not.toHaveBeenCalled();
  });

  it("is silent in groups when the bot is not mentioned (stateless tolerance)", async () => {
    const info = vi.fn();
    const payload: SabhaMessageUpdatedPayload = {
      ...makePayload({
        message: { ...makePayload().message, mentionees: [] },
      }),
      event: "message_updated",
    };
    await handleMessageUpdated(payload, { botId: 42, logger: { info } });
    expect(info).not.toHaveBeenCalled();
  });
});

describe("handleMessageDeleted", () => {
  it("logs and honors self-echo + mention filters", async () => {
    const info = vi.fn();
    const payload: SabhaMessageDeletedPayload = {
      ...makePayload(),
      event: "message_deleted",
    };
    await handleMessageDeleted(payload, { botId: 42, logger: { info } });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("message_deleted"),
    );
  });
});

describe("handleBoostCreated", () => {
  it("logs boost events including the emoji body", async () => {
    const info = vi.fn();
    const payload: SabhaBoostCreatedPayload = {
      ...makePayload(),
      event: "boost_created",
      boost: { id: 77, body: "👍" },
    };
    await handleBoostCreated(payload, { botId: 42, logger: { info } });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("boost_created"));
    const line = info.mock.calls[0][0] as string;
    expect(line).toContain("👍");
    expect(line).toContain("boost=77");
  });

  it("does NOT require an @mention (boosts are global on a message)", async () => {
    const info = vi.fn();
    const payload: SabhaBoostCreatedPayload = {
      ...makePayload({
        message: { ...makePayload().message, mentionees: [] },
      }),
      event: "boost_created",
      boost: { id: 77, body: "👍" },
    };
    await handleBoostCreated(payload, { botId: 42, logger: { info } });
    // Non-mention boost must still be logged — otherwise approval
    // routing (Phase 2.2) would never see the reaction that resolves
    // a pending approval.
    expect(info).toHaveBeenCalledOnce();
  });

  it("filters self-boosts to prevent loops", async () => {
    const info = vi.fn();
    const payload: SabhaBoostCreatedPayload = {
      ...makePayload(),
      event: "boost_created",
      user: { id: 42, name: "MyBot", role: "bot", url: "" },
      boost: { id: 77, body: "👍" },
    };
    await handleBoostCreated(payload, { botId: 42, logger: { info } });
    expect(info).not.toHaveBeenCalled();
  });
});

describe("handleBoostDeleted", () => {
  it("logs the retraction", async () => {
    const info = vi.fn();
    const payload: SabhaBoostDeletedPayload = {
      ...makePayload(),
      event: "boost_deleted",
      boost: { id: 77, body: "👍" },
    };
    await handleBoostDeleted(payload, { botId: 42, logger: { info } });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("boost_deleted"));
  });
});

describe("handleUserCreated / handleUserDeleted (privacy-scoped stubs)", () => {
  it("logs user_created at DEBUG level and emits no agent-visible side effects", async () => {
    const debug = vi.fn();
    const info = vi.fn();
    const error = vi.fn();
    const payload: SabhaUserCreatedPayload = {
      event: "user_created",
      user: {
        id: 77,
        name: "Carol",
        role: "member",
        url: "https://sabha.co/users/77",
      },
    };
    await handleUserCreated(payload, { logger: { debug, info, error } });
    // Critical privacy invariant: these events MUST NOT surface at
    // info-level or higher, and must NOT produce any output beyond the
    // debug log. A future hook that wires them to an agent-visible
    // surface has to opt in explicitly per bot account.
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("user_created"));
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs user_deleted at DEBUG level", async () => {
    const debug = vi.fn();
    const payload: SabhaUserDeletedPayload = {
      event: "user_deleted",
      user: {
        id: 77,
        name: "Carol",
        role: "member",
        url: "https://sabha.co/users/77",
      },
    };
    await handleUserDeleted(payload, { logger: { debug } });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("user_deleted"));
  });
});
