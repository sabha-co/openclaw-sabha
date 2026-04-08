import WebSocket from "ws";
import type { SabhaWebhookPayload } from "./types.js";
import type { ConnectionStatus } from "./types.js";

// -- ActionCable protocol types --

type ActionCableFrame =
  | { type: "welcome" }
  | { type: "ping"; message: number }
  | { type: "confirm_subscription"; identifier: string }
  | { type: "reject_subscription"; identifier: string }
  | { type: "disconnect"; reason?: string; reconnect?: boolean }
  | { identifier: string; message: unknown };

const BOT_EVENTS_IDENTIFIER = JSON.stringify({ channel: "BotEventsChannel" });

// -- WebSocket abstraction (for testing) --

export type WebSocketLike = {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

export type SabhaWebSocketFactory = (url: string) => WebSocketLike;

export const defaultWebSocketFactory: SabhaWebSocketFactory = (url) =>
  new WebSocket(url) as WebSocketLike;

// -- Connect once --

export type ConnectOnceOpts = {
  wsUrl: string;
  abortSignal?: AbortSignal;
  onMessage: (payload: SabhaWebhookPayload) => Promise<void>;
  statusSink?: (patch: Partial<ConnectionStatus>) => void;
  logger?: { info?: (msg: string) => void; error?: (msg: string) => void };
  webSocketFactory?: SabhaWebSocketFactory;
};

export class DisconnectNoReconnectError extends Error {
  constructor(reason?: string) {
    super(`server disconnect (no reconnect): ${reason ?? "unknown"}`);
    this.name = "DisconnectNoReconnectError";
  }
}

export class SubscriptionRejectedError extends Error {
  constructor() {
    super("BotEventsChannel subscription rejected — check bot_key");
    this.name = "SubscriptionRejectedError";
  }
}

/**
 * Create a function that connects once to Sabha via ActionCable WebSocket.
 *
 * Returns a function that resolves when the connection closes normally
 * (reconnect loop should retry) or rejects on fatal errors (stop reconnecting).
 */
export function createSabhaConnectOnce(opts: ConnectOnceOpts): () => Promise<void> {
  const factory = opts.webSocketFactory ?? defaultWebSocketFactory;

  return async () => {
    const ws = factory(opts.wsUrl);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await new Promise<void>((resolve, reject) => {
        let settled = false;

        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const rejectOnce = (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        };

        ws.on("open", () => {
          opts.logger?.info?.("[sabha] WebSocket connected, waiting for welcome");
        });

        ws.on("message", async (data) => {
          const raw = rawDataToString(data);
          const frame = parseFrame(raw);
          if (!frame) return;

          if ("type" in frame) {
            switch (frame.type) {
              case "welcome":
                opts.logger?.info?.("[sabha] Received welcome, subscribing to BotEventsChannel");
                ws.send(JSON.stringify({
                  command: "subscribe",
                  identifier: BOT_EVENTS_IDENTIFIER,
                }));
                break;

              case "confirm_subscription":
                opts.logger?.info?.("[sabha] Subscribed to BotEventsChannel");
                opts.statusSink?.({
                  connected: true,
                  lastConnectedAt: Date.now(),
                  lastError: null,
                });
                break;

              case "reject_subscription":
                opts.logger?.error?.("[sabha] Subscription rejected — check bot_key");
                opts.statusSink?.({ lastError: "Subscription rejected" });
                rejectOnce(new SubscriptionRejectedError());
                ws.close();
                break;

              case "ping":
                // ActionCable keepalive — ignore
                break;

              case "disconnect":
                opts.logger?.info?.(
                  `[sabha] Server disconnect: ${frame.reason ?? "unknown"} (reconnect: ${frame.reconnect ?? true})`,
                );
                if (frame.reconnect === false) {
                  rejectOnce(new DisconnectNoReconnectError(frame.reason));
                  ws.close();
                } else {
                  ws.close();
                }
                break;
            }
            return;
          }

          // Data message — ActionCable wraps the payload in { identifier, message }
          if ("identifier" in frame && "message" in frame && frame.message) {
            try {
              await opts.onMessage(frame.message as SabhaWebhookPayload);
            } catch (err) {
              opts.logger?.error?.(`[sabha] Message handler error: ${String(err)}`);
            }
          }
        });

        ws.on("close", (code, reason) => {
          const msg = reasonToString(reason);
          opts.statusSink?.({
            connected: false,
            lastDisconnect: { at: Date.now(), status: code, error: msg || undefined },
          });
          opts.logger?.info?.(`[sabha] WebSocket closed (code: ${code}${msg ? `, reason: ${msg}` : ""})`);
          resolveOnce();
        });

        ws.on("error", (err) => {
          opts.logger?.error?.(`[sabha] WebSocket error: ${String(err)}`);
          opts.statusSink?.({ lastError: String(err) });
          try { ws.close(); } catch {}
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}

// -- Helpers --

function parseFrame(raw: string): ActionCableFrame | null {
  try {
    return JSON.parse(raw) as ActionCableFrame;
  } catch {
    return null;
  }
}

export function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  // ArrayBuffer
  return Buffer.from(data).toString("utf8");
}

function reasonToString(reason: Buffer | string | undefined): string {
  if (!reason) return "";
  if (typeof reason === "string") return reason;
  return reason.length > 0 ? reason.toString("utf8") : "";
}
