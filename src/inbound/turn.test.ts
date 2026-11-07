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

function setup(outcome: "followup" | "done") {
  const frames: SabhaDraftFrame[] = [];
  let captured: Lifecycle | undefined;
  const runtime = {
    channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main" }) },
      commands: { isControlCommandMessage: () => false },
      reply: { formatAgentEnvelope: () => "env", resolveEnvelopeFormatOptions: () => ({}) },
      inbound: {
        buildContext: () => ({}),
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
    client: {} as SabhaClient,
    performDraft: (frame: SabhaDraftFrame) => (frames.push(frame), true),
    log: {},
  };
  const lifecycle = { onSettled: vi.fn() };
  return { frames, deps, lifecycle, settle: () => captured?.onSettled?.() };
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
});
