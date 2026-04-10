import { describe, it, expect, vi, beforeEach } from "vitest";
import { processInboundMessage } from "./inbound.js";
import type { SabhaWebhookPayload, SabhaAccount } from "./types.js";
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

function makePayload(overrides: Partial<SabhaWebhookPayload> = {}): SabhaWebhookPayload {
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
});
