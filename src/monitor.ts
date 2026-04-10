import type { PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

type ChannelRuntime = PluginRuntime["channel"];
import type { SabhaWebhookPayload, ConnectionStatus } from "./types.js";
import type { ResolvedBotAccount } from "./bot-accounts.js";
import { SabhaClient } from "./client.js";
import { processInboundMessage, shouldHandleInbound } from "./inbound.js";
import { parseWebhookPayload } from "./webhook.js";
import {
  createSabhaConnectOnce,
  createConnectionRef,
  DisconnectNoReconnectError,
  SubscriptionRejectedError,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { createDedupCache } from "./dedup.js";
import { TypingManager } from "./typing.js";

const DEDUP_TTL_MS = 5 * 60_000; // 5 minutes
const DEDUP_MAX_SIZE = 2000;

export type MonitorSabhaOpts = {
  /**
   * The bot account this monitor runs as. Provides baseUrl, botKey,
   * botId, typingEnabled, and the resolved account id used in log
   * prefixes and session routing.
   */
  botAccount: ResolvedBotAccount;
  config: OpenClawConfig;
  runtime: PluginRuntime | ChannelRuntime;
  abortSignal?: AbortSignal;
  logger?: { info?: (msg: string) => void; error?: (msg: string) => void };
  statusSink?: (patch: Partial<ConnectionStatus>) => void;
};

/**
 * Build a WebSocket URL from a Sabha base URL.
 *
 * Converts http→ws / https→wss and appends /cable with bot_key param.
 * If websocketUrl is provided (from registration), uses that directly.
 */
export function buildWebSocketUrl(baseUrl: string, botKey: string, websocketUrl?: string): string {
  if (websocketUrl) return websocketUrl;

  // baseUrl may include a workspace prefix, e.g. http://localhost:3000/1000006
  // Extract workspace ID from path for multi-tenant SaaS mode
  const url = new URL(baseUrl);
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  const wsBase = `${wsScheme}//${url.host}/cable`;
  const params = new URLSearchParams({ bot_key: botKey });

  // Multi-tenant: workspace ID is a 7+ digit path prefix (e.g. /1000006)
  const widMatch = url.pathname.match(/^\/(\d{7,})/);
  if (widMatch) {
    params.set("wid", widMatch[1]);
  }

  return `${wsBase}?${params.toString()}`;
}

/**
 * Long-lived WebSocket monitor for Sabha events.
 *
 * Connects to Sabha via ActionCable, subscribes to BotEventsChannel,
 * and dispatches received events through the same inbound pipeline as webhooks.
 * Reconnects automatically with exponential backoff.
 */
export async function monitorSabha(opts: MonitorSabhaOpts): Promise<void> {
  const { botAccount: account, config, runtime, abortSignal, logger, statusSink } = opts;
  const logPrefix = `[sabha:${account.accountId}]`;
  const client = new SabhaClient(account.baseUrl, account.botKey, { abortSignal });

  const wsUrl = buildWebSocketUrl(
    account.baseUrl,
    account.botKey,
    account.websocketUrl,
  );
  logger?.info?.(
    `${logPrefix} Connecting via WebSocket to ${wsUrl.replace(/bot_key=[^&]+/, "bot_key=***")}`,
  );

  const dedup = createDedupCache({ ttlMs: DEDUP_TTL_MS, maxSize: DEDUP_MAX_SIZE });

  // In-flight processing set. Guards against two hazards that surface when a
  // reply takes longer than the connection lives:
  //   1. Head-of-line blocking — the ws read loop must not `await` on
  //      processInboundMessage, or one slow reply stalls every subsequent
  //      inbound on this socket.
  //   2. Reconnect double-dispatch — if the socket closes mid-processing and
  //      Sabha redelivers on reconnect, the in-flight set drops the duplicate
  //      before it races the original run.
  // Keyed by dedupKey so the guard composes with the TTL dedup cache.
  const inFlight = new Map<string, Promise<void>>();

  // Shared reference that points to the current ws.send — updated by
  // createSabhaConnectOnce whenever a new connection opens/closes.
  const connectionRef = createConnectionRef();

  const typing = account.typingEnabled
    ? new TypingManager({
        connectionRef,
        botId: account.botId,
        botName: account.botName,
        logger,
      })
    : null;

  const connectOnce = createSabhaConnectOnce({
    wsUrl,
    abortSignal,
    logger,
    statusSink,
    connectionRef,
    onBotEventsSubscribed: () => {
      // Server forgot any prior typing subscriptions on reconnect —
      // reset local state so the next start() re-subscribes.
      typing?.reset();
    },
    onAuxSubscriptionConfirmed: (identifier) => {
      typing?.onSubscriptionConfirmed(identifier);
    },
    onAuxSubscriptionRejected: (identifier) => {
      typing?.onSubscriptionRejected(identifier);
    },
    onMessage: async (raw) => {
      let payload: SabhaWebhookPayload;
      try {
        payload = parseWebhookPayload(raw);
      } catch (err) {
        logger?.error?.(`${logPrefix} Invalid WebSocket payload: ${err}`);
        return;
      }

      if (payload.event !== "message_created") return;

      // Pre-flight gating — skip self/non-mention before any side effects
      // (dedup mark, status update, typing indicator). This ensures the
      // bot doesn't flicker a typing indicator for messages it will ignore.
      if (!shouldHandleInbound(payload, account.botId)) return;

      const dedupKey = `msg:${payload.message.id}`;
      if (dedup.has(dedupKey) || inFlight.has(dedupKey)) {
        logger?.info?.(`${logPrefix} Skipping duplicate message ${payload.message.id}`);
        return;
      }

      // Optimistic mark: reserve the dedup slot *before* processing so a
      // reconnect-driven redelivery that arrives while work is still in
      // flight is suppressed by the in-flight guard + dedup cache. On
      // failure we unmark below so the next reconnect redelivery can retry
      // — Sabha only redelivers on reconnect, not on ack/NACK, so dropping
      // the mark permanently would turn every transient failure into a
      // silent lost reply.
      dedup.mark(dedupKey);
      statusSink?.({ lastInboundAt: Date.now() });
      typing?.start(payload.room.id);

      const work = (async () => {
        try {
          await processInboundMessage(payload, {
            runtime,
            cfg: config,
            account,
            deliver: async (replyPayload) => {
              const roomId = Number(replyPayload.to ?? payload.room.id);
              const text = replyPayload.text ?? replyPayload.body ?? "";

              if (replyPayload.threadId && replyPayload.replyToId) {
                await client.replyInThread(roomId, Number(replyPayload.replyToId), text);
              } else {
                await client.sendMessage(roomId, text);
              }
            },
            logger,
          });
        } catch (err) {
          // Roll back the optimistic mark so a future reconnect redelivery
          // of this message_created event gets a fresh attempt instead of
          // being silently dropped as a duplicate.
          dedup.unmark(dedupKey);
          logger?.error?.(`${logPrefix} Failed to process message ${payload.message.id}: ${err}`);
        } finally {
          typing?.stop(payload.room.id);
          inFlight.delete(dedupKey);
        }
      })();
      inFlight.set(dedupKey, work);
    },
  });

  try {
    await runWithReconnect(connectOnce, {
      abortSignal,
      jitterRatio: 0.2,
      shouldReconnect: ({ error }) => {
        // Server explicitly told us not to reconnect (auth failure, etc.)
        if (error instanceof DisconnectNoReconnectError) return false;
        // Subscription rejected — bot_key is invalid/unauthorized
        if (error instanceof SubscriptionRejectedError) return false;
        return true;
      },
      onError: (err) => {
        logger?.error?.(`${logPrefix} WebSocket connection failed: ${String(err)}`);
      },
      onReconnect: (delayMs) => {
        logger?.info?.(`${logPrefix} Reconnecting in ${Math.round(delayMs / 1000)}s`);
      },
    });
  } finally {
    // Cancel any outstanding refresh timers so the monitor can be GC'd.
    typing?.reset();
    // Drain in-flight processing so we don't leave dangling fetches or
    // half-sent replies after the monitor returns. The SabhaClient holds
    // the same abortSignal, so an aborted shutdown cancels the pending
    // HTTP calls and each work promise unwinds quickly.
    if (inFlight.size > 0) {
      logger?.info?.(`${logPrefix} Draining ${inFlight.size} in-flight message(s)`);
      await Promise.allSettled(inFlight.values());
    }
  }
}

