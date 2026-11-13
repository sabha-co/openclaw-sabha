import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { APP_EVENTS_IDENTIFIER, CABLE_PROTOCOL, CableRejectedError, connectCable, type StreamPositions } from "./cable-socket.js";

type Server = { url: string; received: unknown[]; headers: Record<string, unknown>; socket: () => WebSocket; close: () => Promise<void> };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fakeAnyCable(onFrame: (frame: Record<string, unknown>, ws: WebSocket) => void, onConnect?: (ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0, handleProtocols: (protocols) => (protocols.has(CABLE_PROTOCOL) ? CABLE_PROTOCOL : false) });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const server: Server = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/cable`,
    received: [],
    headers: {},
    socket: () => [...wss.clients][0]!,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    }),
  };
  wss.on("connection", (ws, request) => {
    server.headers = { ...request.headers };
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      server.received.push(frame);
      onFrame(frame, ws);
    });
    if (onConnect) onConnect(ws);
    else ws.send(JSON.stringify({ type: "welcome" }));
  });
  servers.push(server);
  return server;
}

const confirming = (frame: Record<string, unknown>, ws: WebSocket) => {
  if (frame.command === "subscribe") ws.send(JSON.stringify({ identifier: frame.identifier, type: "confirm_subscription" }));
};

function run(server: Server, overrides: Partial<Parameters<typeof connectCable>[0]> = {}) {
  const controller = new AbortController();
  const events: unknown[] = [];
  const metas: unknown[] = [];
  const positions: StreamPositions = new Map();
  let session: Parameters<Parameters<typeof connectCable>[0]["onReady"]>[0] | undefined;
  const outcome = connectCable({
    url: server.url,
    appKey: "sabha_app_k",
    abortSignal: controller.signal,
    positions,
    onReady: (s) => (session = s),
    onEvent: (message, meta) => {
      events.push(message);
      metas.push(meta);
    },
    ...overrides,
  });
  return { controller, events, metas, positions, outcome, session: () => session };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

describe("connectCable", () => {
  it("authenticates by header, subscribes, and delivers events with their stream position", async () => {
    const server = await fakeAnyCable((frame, ws) => {
      confirming(frame, ws);
      if (frame.command === "subscribe") {
        ws.send(JSON.stringify({ identifier: APP_EVENTS_IDENTIFIER, message: { event: "message_created" }, stream_id: "app_events:508", epoch: "e1", offset: 4 }));
      }
    });
    const run1 = run(server);
    await until(() => run1.events.length === 1);
    expect(server.headers.authorization).toBe("Bearer sabha_app_k");
    expect(server.headers["sec-websocket-protocol"]).toBe(CABLE_PROTOCOL);
    expect(run1.metas[0]).toEqual({ streamId: "app_events:508", epoch: "e1", offset: 4 });
    // Advancing positions is the monitor's job, after the event is durably stored.
    expect(run1.positions.size).toBe(0);

    expect(run1.session()!.perform("draft", { kind: "start", draft_id: "d" })).toBe(true);
    await until(() => server.received.length === 2);
    expect(server.received[1]).toEqual({
      command: "message",
      identifier: APP_EVENTS_IDENTIFIER,
      data: JSON.stringify({ kind: "start", draft_id: "d", action: "draft" }),
    });

    run1.controller.abort();
    await expect(run1.outcome).resolves.toMatchObject({ ready: true, terminal: undefined });
  });

  it("asks for missed events after a reconnect", async () => {
    const server = await fakeAnyCable(confirming);
    const positions: StreamPositions = new Map([["app_events:508", { epoch: "e1", offset: 9 }]]);
    const run1 = run(server, { positions, resumeSince: 1_700_000_000 });
    await until(() => server.received.length === 2);
    expect(server.received[1]).toEqual({
      command: "history",
      identifier: APP_EVENTS_IDENTIFIER,
      history: { streams: { "app_events:508": { epoch: "e1", offset: 9 } }, since: 1_700_000_000 },
    });
    run1.controller.abort();
    await run1.outcome;
  });

  it("asks again by time alone, once, when Sabha refuses the saved positions", async () => {
    const server = await fakeAnyCable((frame, ws) => {
      confirming(frame, ws);
      if (frame.command === "history") ws.send(JSON.stringify({ identifier: frame.identifier, type: "reject_history" }));
    });
    const positions: StreamPositions = new Map([["app_events:508", { epoch: "e1", offset: 9 }]]);
    const results: string[] = [];
    const run1 = run(server, { positions, resumeSince: 1_700_000_000, onHistory: (result) => results.push(result) });
    await until(() => results.length === 2);
    expect(server.received.slice(1)).toEqual([
      expect.objectContaining({ command: "history" }),
      { command: "history", identifier: APP_EVENTS_IDENTIFIER, history: { since: 1_700_000_000 } },
    ]);
    expect(results).toEqual(["stale", "rejected"]);
    run1.controller.abort();
    await run1.outcome;
  });

  it("does not replay anything on a first connection", async () => {
    const server = await fakeAnyCable(confirming);
    const run1 = run(server);
    await until(() => run1.session() !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.received).toHaveLength(1);
    run1.controller.abort();
    await run1.outcome;
  });

  it("treats a rejected subscription as terminal", async () => {
    const server = await fakeAnyCable((frame, ws) => {
      if (frame.command === "subscribe") ws.send(JSON.stringify({ identifier: frame.identifier, type: "reject_subscription" }));
    });
    const outcome = await run(server).outcome;
    expect(outcome.ready).toBe(false);
    expect(outcome.terminal).toBeInstanceOf(CableRejectedError);
  });

  it("treats a do-not-reconnect disconnect as terminal", async () => {
    const server = await fakeAnyCable(() => {}, (ws) => ws.send(JSON.stringify({ type: "disconnect", reason: "unauthorized", reconnect: false })));
    expect((await run(server).outcome).terminal).toBeInstanceOf(CableRejectedError);
  });

  it("drops a connection that never confirms or goes silent", async () => {
    const silent = await fakeAnyCable(() => {});
    const unconfirmed = await run(silent, { timeouts: { subscribeMs: 30, silenceMs: 1_000 } }).outcome;
    expect(unconfirmed).toMatchObject({ ready: false, terminal: undefined });

    const quiet = await fakeAnyCable(confirming);
    const stale = await run(quiet, { timeouts: { silenceMs: 40 } }).outcome;
    expect(stale).toMatchObject({ ready: true, terminal: undefined });
  });
});
