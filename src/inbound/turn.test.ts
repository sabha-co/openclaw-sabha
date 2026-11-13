import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it, vi } from "vitest";
import type { SabhaClient } from "../client/client.js";
import type { SabhaDraftFrame, SabhaMessageEvent } from "../client/types.js";
import type { ResolvedSabhaAccount } from "../config/accounts.js";

vi.mock("./access.js", () => ({
  resolveSabhaAccess: vi.fn(async () => ({ ingress: { admission: "dispatch" }, commandAccess: { authorized: false } })),
}));

const { handleSabhaEvent } = await import("./turn.js");

const account = {
  accountId: "default", livePreview: true, replyToMode: "first", rooms: {}, allowPrivateNetwork: false,
} as unknown as ResolvedSabhaAccount;

const event = {
  event: "message_created",
  room: { id: 21, type: "Open", name: "general" },
  user: { id: 5, name: "Ann" },
  message: { id: 4214, created_at: "2026-11-07T00:00:00Z", body: { plain: "@bot hi", markdown: "@bot hi" }, mentions: [{ id: 1 }] },
} as unknown as SabhaMessageEvent;

type Lifecycle = { onSettled?: () => void };

function setup(outcome: "followup" | "done", client: Partial<SabhaClient> = {}) {
  const frames: SabhaDraftFrame[] = [];
  const contexts: Array<{ supplemental?: { thread?: { starterBody?: string } } }> = [];
  let captured: Lifecycle | undefined;
  const runtime = {
    channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main" }) },
      commands: { isControlCommandMessage: () => false },
      reply: { formatAgentEnvelope: () => "env", resolveEnvelopeFormatOptions: () => ({}) },
      inbound: {
        buildContext: (params: (typeof contexts)[number]) => (contexts.push(params), {}),
        run: vi.fn(async (params: { turnAdoptionLifecycle: Lifecycle; adapter: { resolveTurn: () => Promise<unknown> } }) => {
          captured = params.turnAdoptionLifecycle;
          await params.adapter.resolveTurn(); // starts the draft
          return { dispatched: true, dispatchResult: { deferredToActiveRun: outcome === "followup" ? "followup" : undefined } };
        }),
      },
    },
  };
  const deps = {
    runtime: runtime as never,
    cfg: {} as OpenClawConfig,
    account,
    selfId: 1,
    client: client as SabhaClient,
    performDraft: (frame: SabhaDraftFrame) => (frames.push(frame), true),
    log: {},
  };
  const lifecycle = { onSettled: vi.fn() };
  return { frames, contexts, deps, lifecycle, settle: () => captured?.onSettled?.() };
}

describe("message turns", () => {
  it("ends the draft when the turn returns", async () => {
    const { frames, deps, lifecycle } = setup("done");
    await handleSabhaEvent(event, lifecycle as never, deps);
    expect(frames.map((frame) => frame.kind)).toEqual(["start", "end"]);
  });

  it("keeps a deferred follow-up's draft open until the host settles it, then ends it once", async () => {
    const { frames, deps, lifecycle, settle } = setup("followup");
    await handleSabhaEvent(event, lifecycle as never, deps);
    expect(frames.map((frame) => frame.kind)).toEqual(["start"]);
    settle();
    settle();
    await vi.waitFor(() => expect(frames.map((frame) => frame.kind)).toEqual(["start", "end"]));
  });

  describe("in a thread", () => {
    const threaded = {
      ...event,
      room: { id: 221, type: "Thread", name: null },
      message: { ...event.message, thread: { id: 221, parent_message_id: 4100, parent_room_id: 21 } },
    } as unknown as SabhaMessageEvent;

    it("tells the agent what message the thread hangs off", async () => {
      const getMessage = vi.fn(async () => ({ creator: { id: 7, name: "Raj" }, body: { markdown: "Launch is on Friday.", plain: "" } }));
      const { contexts, deps, lifecycle } = setup("done", { getMessage } as never);
      await handleSabhaEvent(threaded, lifecycle as never, deps);
      expect(getMessage).toHaveBeenCalledWith(4100);
      expect(contexts[0]?.supplemental?.thread?.starterBody).toBe("Raj (@{7}): Launch is on Friday.");
    });

    it("says so when the parent can't be loaded", async () => {
      const { contexts, deps, lifecycle } = setup("done", { getMessage: vi.fn(async () => { throw new Error("404"); }) } as never);
      await handleSabhaEvent(threaded, lifecycle as never, deps);
      expect(contexts[0]?.supplemental?.thread?.starterBody).toMatch(/couldn't be loaded/);
    });
  });
});

describe("command turns", () => {
  const command = {
    event: "command", id: "c-1", command: "/model", text: "fast", user_id: 5, user_name: "Ann",
    room_id: 221, room_name: null, thread: { id: 221, parent_message_id: 4100, parent_room_id: 21 }, response_url: "https://r",
  } as const;

  it("runs as the host's native command in the thread's session and answers only the member who ran it", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    let answer: ((payload: { text?: string }) => Promise<unknown>) | undefined;
    const runtime = {
      channel: {
        routing: { resolveAgentRoute: () => ({ agentId: "main" }) },
        commands: { isControlCommandMessage: () => true },
        reply: { formatAgentEnvelope: () => "env", resolveEnvelopeFormatOptions: () => ({}) },
        inbound: {
          buildContext: (params: Record<string, unknown>) => (contexts.push(params), {}),
          run: vi.fn(async (params: { adapter: { ingest: () => { textForCommands: string }; resolveTurn: () => Promise<{ delivery: { deliver: typeof answer } }> } }) => {
            expect(params.adapter.ingest().textForCommands).toBe("/model fast");
            answer = (await params.adapter.resolveTurn()).delivery.deliver;
            return { dispatched: true, dispatchResult: {} };
          }),
        },
      },
    };
    const client = { getRoom: vi.fn(async () => ({ id: 221, name: null, type: "Thread" })), respond: vi.fn(async () => {}), sendMessage: vi.fn() };
    await handleSabhaEvent(command as never, {} as never, {
      runtime: runtime as never, cfg: {} as OpenClawConfig, account, selfId: 1, client: client as never, performDraft: () => true, log: {},
    });
    expect(contexts[0]).toMatchObject({ conversation: { kind: "group", id: "221", threadId: "221" }, extra: { CommandSource: "native" } });
    await answer?.({ text: "Model set" });
    expect(client.respond).toHaveBeenCalledWith("https://r", "Model set");
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
