import type { PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

type ChannelRuntime = PluginRuntime["channel"];
import type { SabhaWebhookPayload, ConnectionStatus } from "./types.js";
import { resolveAccount } from "./channel.js";
import { SabhaClient } from "./client.js";
import { processInboundMessage } from "./inbound.js";
import { parseWebhookPayload } from "./webhook.js";
import {
  createSabhaConnectOnce,
  DisconnectNoReconnectError,
  SubscriptionRejectedError,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { createDedupCache } from "./dedup.js";

const DEDUP_TTL_MS = 5 * 60_000; // 5 minutes
const DEDUP_MAX_SIZE = 2000;

export type MonitorSabhaOpts = {
  baseUrl: string;
  botKey: string;
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
  const { baseUrl, botKey, config, runtime, abortSignal, logger, statusSink } = opts;
  const account = resolveAccount(config);
  const client = new SabhaClient(baseUrl, botKey);

  const wsUrl = buildWebSocketUrl(baseUrl, botKey, account.websocketUrl);
  logger?.info?.(`[sabha] Connecting via WebSocket to ${wsUrl.replace(/bot_key=[^&]+/, "bot_key=***")}`);

  const dedup = createDedupCache({ ttlMs: DEDUP_TTL_MS, maxSize: DEDUP_MAX_SIZE });

  const connectOnce = createSabhaConnectOnce({
    wsUrl,
    abortSignal,
    logger,
    statusSink,
    onMessage: async (raw) => {
      let payload: SabhaWebhookPayload;
      try {
        payload = parseWebhookPayload(raw);
      } catch (err) {
        logger?.error?.(`[sabha] Invalid WebSocket payload: ${err}`);
        return;
      }

      if (payload.event === "message_created") {
        // Dedup: skip messages already processed (e.g. after reconnect)
        const dedupKey = `msg:${payload.message.id}`;
        if (dedup.has(dedupKey)) {
          logger?.info?.(`[sabha] Skipping duplicate message ${payload.message.id}`);
          return;
        }

        statusSink?.({ lastInboundAt: Date.now() });
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
          // Mark as seen only after successful processing
          dedup.mark(dedupKey);
        } catch (err) {
          // Don't mark as seen — allow retry on next delivery
          logger?.error?.(`[sabha] Failed to process message ${payload.message.id}: ${err}`);
        }
      }
    },
  });

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
      logger?.error?.(`[sabha] WebSocket connection failed: ${String(err)}`);
    },
    onReconnect: (delayMs) => {
      logger?.info?.(`[sabha] Reconnecting in ${Math.round(delayMs / 1000)}s`);
    },
  });
}

