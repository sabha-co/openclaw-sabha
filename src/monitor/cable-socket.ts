// One ActionCable connection to Sabha's AppEventsChannel, on AnyCable's
// extended protocol so a reconnect can ask for the events it missed.
//
// Lifecycle: open -> welcome -> subscribe -> confirm (ready) -> events … -> close.
// The promise resolves on close with what happened; the monitor decides
// whether and when to reconnect.
import { type RawData, WebSocket } from "openclaw/plugin-sdk/websocket-runtime";

export const APP_EVENTS_IDENTIFIER = JSON.stringify({ channel: "AppEventsChannel" });
export const CABLE_PROTOCOL = "actioncable-v1-ext-json";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export type CableTimeouts = { handshakeMs: number; subscribeMs: number; silenceMs: number };
export const DEFAULT_CABLE_TIMEOUTS: CableTimeouts = { handshakeMs: 10_000, subscribeMs: 10_000, silenceMs: 10_000 };

/** Last durably handled position per AnyCable stream, kept by the monitor across connections. */
export type StreamPositions = Map<string, { epoch: string; offset: number }>;

export type CableEventMeta = { streamId?: string; epoch?: string; offset?: number };

export type CableSession = {
  /** Perform a channel action (e.g. `draft`). False when the socket is no longer open. */
  perform(action: string, data: Record<string, unknown>): boolean;
  /** Drop this connection so the monitor reconnects and replays from the positions it holds. */
  close(): void;
};

export type CableOutcome = {
  /** The subscription was confirmed before the socket closed. */
  ready: boolean;
  /** Set when retrying cannot help (bad key, server said do not reconnect). */
  terminal?: Error;
  code?: number;
  reason?: string;
};

export class CableRejectedError extends Error {
  constructor(detail: string) {
    super(`Sabha refused the app connection (${detail}); check the app key`);
    this.name = "CableRejectedError";
  }
}

export type CableSocketLike = {
  readonly readyState: number;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: RawData) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number }) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

export type CreateCableSocket = (url: string, options: { headers: Record<string, string>; protocol: string }) => CableSocketLike;

export const createCableSocket: CreateCableSocket = (url, { headers, protocol }) =>
  new WebSocket(url, [protocol], {
    headers,
    maxPayload: MAX_PAYLOAD_BYTES,
    handshakeTimeout: DEFAULT_CABLE_TIMEOUTS.handshakeMs,
  }) as unknown as CableSocketLike;

type Frame = {
  type?: string;
  identifier?: string;
  message?: unknown;
  reason?: string;
  reconnect?: boolean;
  stream_id?: string;
  epoch?: string;
  offset?: number;
};

export function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

export function connectCable(params: {
  url: string;
  appKey: string;
  abortSignal: AbortSignal;
  positions: StreamPositions;
  /** UNIX seconds: replay from here for streams with no known position. */
  resumeSince?: number;
  onReady: (session: CableSession) => void;
  onEvent: (message: unknown, meta: CableEventMeta) => void;
  /** `stale`: the saved positions were refused, and missed events are asked for again by time. */
  onHistory?: (result: "confirmed" | "rejected" | "stale") => void;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
  createSocket?: CreateCableSocket;
  timeouts?: Partial<CableTimeouts>;
}): Promise<CableOutcome> {
  const timeouts = { ...DEFAULT_CABLE_TIMEOUTS, ...params.timeouts };
  const ws = (params.createSocket ?? createCableSocket)(params.url, {
    headers: { Authorization: `Bearer ${params.appKey}` },
    protocol: CABLE_PROTOCOL,
  });

  return new Promise<CableOutcome>((resolve) => {
    let ready = false;
    let terminal: Error | undefined;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (why: string) => {
      params.log?.warn?.(`[sabha] ${why}; dropping the connection`);
      ws.terminate();
    };
    const armPhase = (ms: number, why: string) => {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => kill(why), ms);
    };
    // Sabha pings every 3s; prolonged silence means a dead path, not an idle one.
    const armSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => kill(`no frames for ${timeouts.silenceMs}ms`), timeouts.silenceMs);
    };
    const onAbort = () => ws.terminate();
    params.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (params.abortSignal.aborted) ws.terminate();

    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    };
    const session: CableSession = {
      perform: (action, data) =>
        send({ command: "message", identifier: APP_EVENTS_IDENTIFIER, data: JSON.stringify({ ...data, action }) }),
      close: () => ws.terminate(),
    };

    let askedByPosition = false;
    const requestHistory = () => {
      const streams = Object.fromEntries(params.positions);
      if (Object.keys(streams).length === 0 && params.resumeSince === undefined) return;
      askedByPosition = Object.keys(streams).length > 0;
      const history: Record<string, unknown> = { streams };
      if (params.resumeSince !== undefined) history.since = params.resumeSince;
      send({ command: "history", identifier: APP_EVENTS_IDENTIFIER, history });
    };

    armPhase(timeouts.handshakeMs, "no welcome from Sabha");

    ws.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      if (status === 401 || status === 403) terminal = new CableRejectedError(`HTTP ${status}`);
      kill(`cable handshake answered HTTP ${status}`);
    });

    ws.on("message", (data) => {
      armSilence();
      let frame: Frame;
      try {
        frame = JSON.parse(rawDataToString(data)) as Frame;
      } catch {
        return;
      }
      switch (frame.type) {
        case "ping":
          return;
        case "welcome":
          armPhase(timeouts.subscribeMs, "AppEventsChannel subscription was never confirmed");
          send({ command: "subscribe", identifier: APP_EVENTS_IDENTIFIER });
          return;
        case "confirm_subscription":
          if (frame.identifier !== APP_EVENTS_IDENTIFIER) return;
          clearTimeout(phaseTimer);
          ready = true;
          params.onReady(session);
          requestHistory();
          return;
        case "reject_subscription":
          if (frame.identifier !== APP_EVENTS_IDENTIFIER) return;
          terminal = new CableRejectedError("subscription rejected");
          ws.close();
          return;
        case "confirm_history":
          params.onHistory?.("confirmed");
          return;
        case "reject_history":
          // A stream whose history expired starts over at offset 1 in the same
          // epoch, so a saved offset is past its newest entry. `since` applies
          // only to streams with no position, so ask again by time alone, once.
          if (askedByPosition && params.resumeSince !== undefined) {
            askedByPosition = false;
            params.onHistory?.("stale");
            params.log?.info?.("[sabha] saved stream positions are stale; asking for missed events by time");
            send({ command: "history", identifier: APP_EVENTS_IDENTIFIER, history: { since: params.resumeSince } });
            return;
          }
          params.log?.warn?.("[sabha] Sabha could not replay missed events (history expired or the server restarted)");
          params.onHistory?.("rejected");
          return;
        case "disconnect":
          if (frame.reconnect === false) terminal = new CableRejectedError(frame.reason ?? "disconnect");
          ws.close();
          return;
      }
      if (frame.identifier !== APP_EVENTS_IDENTIFIER || frame.message == null) return;
      // Positions are the monitor's to advance, once the event is durably stored.
      params.onEvent(frame.message, { streamId: frame.stream_id, epoch: frame.epoch, offset: frame.offset });
    });

    ws.on("error", (error) => {
      params.log?.warn?.(`[sabha] cable error: ${error.message}`);
    });

    ws.on("close", (code, reason) => {
      clearTimeout(phaseTimer);
      clearTimeout(silenceTimer);
      params.abortSignal.removeEventListener("abort", onAbort);
      resolve({ ready, terminal, code, reason: reason?.length ? reason.toString("utf8") : undefined });
    });
  });
}
