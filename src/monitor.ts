import type { PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

type ChannelRuntime = PluginRuntime["channel"];
import type { SabhaWebhookPayload, ConnectionStatus } from "./types.js";
import type { ResolvedSabhaAccount } from "./accounts.js";
import { SabhaClient } from "./client.js";
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
import { createSabhaDraftStream, formatStreamError } from "./draft-stream.js";
import { MentionRewriter } from "./outbound/mention-rewrite.js";

const DEDUP_TTL_MS = 5 * 60_000; // 5 minutes
const DEDUP_MAX_SIZE = 2000;

/**
 * Park until `abortSignal` fires. Used on fatal, unrecoverable errors
 * to prevent the SDK's account supervisor from treating a clean return
 * from `monitorSabha` as "finished" and auto-restarting us into the
 * same failure. `channel.ts` has a sibling helper on the unserviceable
 * path; this is the same idea, applied after the reconnect loop bails.
 */
function waitForAbort(abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return new Promise(() => {});
  if (abortSignal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Build a dedup cache key from a webhook payload. Keys are scoped by
 * `event` so the same numeric id across variants (e.g. message id 42
 * as a create, update, and delete) never collide — each is a distinct
 * event the agent should see at most once.
 *
 * For `message_updated`, the key also folds in `updated_at` so
 * repeated edits of the same message id are treated as distinct
 * events. Without the timestamp tiebreaker, every edit of message 14
 * would hash to `message_updated:14` and the second edit through the
 * pipeline would be silently dropped as a "duplicate" — which the
 * self-echo pre-filter in `onMessage` mostly covers in practice (the
 * stream of `editMessage` echoes from the bot's own partials never
 * reaches dedup) but which would still silently drop a real user's
 * second edit of their own message within the 5-minute dedup window.
 *
 * `user_*` events fan out globally and don't carry a stable per-event
 * id the plugin can dedup against, so we return `null` — they bypass
 * the cache entirely. The stub handlers are side-effect-free, so
 * duplicate delivery on reconnect is harmless.
 */
export function buildDedupKey(payload: SabhaWebhookPayload): string | null {
  switch (payload.event) {
    case "message_created":
      return `${payload.event}:${payload.message.id}`;
    case "message_updated":
      // Include `updated_at` so a user editing the same message twice
      // in quick succession is not collapsed into one cache slot. The
      // timestamp comes from the server side of Sabha (see
      // `app/models/bot/event_payload.rb`) so clock drift between the
      // bot host and Sabha does not matter.
      return `${payload.event}:${payload.message.id}:${payload.message.updated_at}`;
    case "message_deleted":
      // A message can only be deleted once; no tiebreaker required.
      return `${payload.event}:${payload.message.id}`;
    case "boost_created":
    case "boost_deleted":
      return `${payload.event}:${payload.boost.id}`;
    case "user_created":
    case "user_deleted":
      return null;
  }
}

/**
 * Pre-filter for events the bot caused itself. Returns true when the
 * payload's actor is the bot, for every variant that can plausibly be
 * bot-originated (message create/update/delete and boost create/delete).
 *
 * Runs BEFORE the dedup cache check in `onMessage` so self-echoes
 * never touch the cache and never produce "Skipping duplicate" log
 * noise. This is load-bearing for streaming: every `editMessage` the
 * bot issues causes Sabha to fan a `message_updated` frame back over
 * the WS (Scout A, hazard #2), and a ~10-edit streaming turn without
 * the pre-filter produces ~10 info-level log lines per turn and
 * pollutes the dedup cache with entries that end up collapsing real
 * events.
 *
 * `user_*` events are never bot-originated (Sabha fires these when a
 * workspace member is created/deleted, not when a bot acts), so they
 * are always passed through here. The downstream `user_*` stubs are
 * side-effect-free per the privacy invariant in `src/inbound.ts`.
 *
 * The per-handler `shouldHandleInbound` check in `src/inbound.ts`
 * still re-runs the same test as a belt-and-suspenders defense —
 * removing it here would leave correctness to a single gate in
 * `monitor.ts`, which is a change we don't want.
 */
export function isSelfEchoEvent(
  payload: SabhaWebhookPayload,
  botId: number,
): boolean {
  switch (payload.event) {
    case "message_created":
    case "message_updated":
    case "message_deleted":
    case "boost_created":
    case "boost_deleted":
      return payload.user.id === botId;
    case "user_created":
    case "user_deleted":
      return false;
  }
}

export type MonitorSabhaOpts = {
  /**
   * The bot account this monitor runs as. Provides baseUrl, apiBaseUrl,
   * botKey, botId, typingEnabled, and the resolved account id used in
   * log prefixes and session routing.
   */
  account: ResolvedSabhaAccount;
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
  const { account, config, runtime, abortSignal, logger, statusSink } = opts;
  const logPrefix = `[sabha:${account.accountId}]`;
  // Mention rewriter: maps display names → user ids so outbound @Name
  // tokens get deterministically rewritten to @{id} for format_mentions.
  // Populated from every inbound event's user.id + user.name + mentionees.
  const mentionRewriter = new MentionRewriter();
  const client = new SabhaClient(account.apiBaseUrl, account.botKey, {
    abortSignal,
    mentionRewriter: (text) => mentionRewriter.rewrite(text),
  });

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

      // Self-echo pre-filter: drop events caused by the bot itself
      // before they touch the dedup cache or the log. Without this
      // early return, every `editMessage` the bot issues during a
      // streaming turn causes Sabha to fan a `message_updated` frame
      // back over the WS (Scout A, hazard #2), polluting the dedup
      // cache with the bot's own echoes
      // and producing one "Skipping duplicate" info line per edit
      // as soon as the `message_updated:<id>` dedup slot was first
      // marked. Per-handler `shouldHandleInbound` still re-checks
      // self-echo as a defensive double-check (see src/inbound.ts).
      if (isSelfEchoEvent(payload, account.botId)) return;

      // Diagnostic: log every inbound (non-self-echo) event so we can
      // see what Sabha is sending us. Temporary — remove once threaded
      // follow-ups are confirmed working.
      if ("room" in payload && payload.room && "message" in payload && payload.message) {
        const msg = payload.message as { id: number; thread?: unknown };
        logger?.info?.(
          `${logPrefix} inbound ${payload.event} room=${payload.room.id} type=${payload.room.type} msgId=${msg.id} inThread=${msg.thread != null}`,
        );
      }

      // Feed every inbound event's user into the mention rewriter so
      // outbound @DisplayName → @{id} rewrites work for every user
      // the bot has seen. Also feed mentionees from message events so
      // the bot can mention users it hasn't directly interacted with.
      if ("user" in payload && payload.user) {
        mentionRewriter.add(payload.user.name, payload.user.id);
      }
      if ("message" in payload && payload.message?.mentionees) {
        for (const m of payload.message.mentionees) {
          mentionRewriter.add(m.name, m.id);
        }
      }

      // Dedup keys are scoped by event type so the same numeric id
      // never collides across variants — e.g. `message_created:42`
      // must not dedup `message_updated:42`, since those are two
      // distinct events that the agent should observe independently.
      // `message_updated` additionally folds in `updated_at` so two
      // legitimate edits of the same message id within the dedup
      // window are treated as distinct events — see `buildDedupKey`.
      // See src/dedup.ts — 2000-entry FIFO / 5min TTL is wide enough
      // to absorb reconnect replay across all variants (Q5).
      const dedupKey = buildDedupKey(payload);
      if (dedupKey && (dedup.has(dedupKey) || inFlight.has(dedupKey))) {
        logger?.info?.(`${logPrefix} Skipping duplicate ${dedupKey}`);
        return;
      }

      // `message_created` is the only variant that runs the full reply
      // pipeline (typing indicator → dispatch → deliver). Every other
      // variant routes to a typed log-only handler. A future approval-
      // routing pass will upgrade `boost_created` to consume pending
      // approvals, and `message_updated` may eventually grow into an
      // edit-propagation path.
      if (payload.event === "message_created") {
        if (!shouldHandleInbound(payload, account.botId)) return;

        // Optimistic mark: reserve the dedup slot *before* processing
        // so a reconnect-driven redelivery that arrives while work is
        // still in flight is suppressed by the in-flight guard + dedup
        // cache. On failure we unmark below so the next reconnect
        // redelivery can retry — Sabha only redelivers on reconnect,
        // not on ack/NACK, so dropping the mark permanently would turn
        // every transient failure into a silent lost reply.
        dedup.mark(dedupKey!);
        statusSink?.({ lastInboundAt: Date.now() });
        typing?.start(payload.room.id);

        // Decide threading once for the turn. The SDK's internal reply
        // planner doesn't call our plugin's `threading.resolveReplyToMode`
        // — it reads raw config at a different code path and often doesn't
        // set `replyToId` even when mode is "all". So we resolve the mode
        // here directly and decide whether to create a thread ourselves.
        //
        // Sabha models threads as Room subclasses. When the inbound is
        // already in a thread, `payload.room.id` is the thread's room id
        // and plain `sendMessage(roomId, ...)` posts into the thread —
        // calling `replyInThread` would create a nested thread, wrong.
        //
        // Sabha's /thread endpoint is idempotent via `find_or_create_for`:
        // calling `replyInThread(roomId, userMessageId)` multiple times in
        // a turn appends to the same thread. So "first" and "all" modes
        // collapse on Sabha — thread the reply or don't.
        const isInThread = payload.message.thread != null;
        const isDm = payload.room.type === "Direct";
        const replyToMode = account.replyToMode ?? "first";
        const shouldThread = !isInThread && !isDm && replyToMode !== "off";

        // Streaming draft-stream preview. Lives for the duration of one
        // inbound turn and is shared between `onPartialReply` (per-token
        // updates) and `deliver` (final edit).
        //
        // For the threading-on case we wire a `firstSend` hook: the very
        // first partial is posted via `replyInThread`, which creates the
        // thread server-side and returns the new thread room id. The
        // stream rebinds its room id to that captured value so all
        // subsequent edits (and the recovery / error-replace paths via
        // `draftStream.roomId()`) target the thread, not the parent.
        const draftStream = createSabhaDraftStream({
          client,
          roomId: payload.room.id,
          ...(shouldThread
            ? {
                firstSend: async (text) => {
                  const r = await client.replyInThread(
                    payload.room.id,
                    payload.message.id,
                    text,
                  );
                  return { roomId: r.thread.id, messageId: r.message.id };
                },
              }
            : {}),
          logger: {
            debug: (msg) => logger?.info?.(`${logPrefix} ${msg}`),
            warn: (msg) => logger?.error?.(`${logPrefix} ${msg}`),
          },
        });

        logger?.info?.(
          `${logPrefix} deliver gate: mode=${replyToMode} isInThread=${isInThread} isDm=${isDm} willThread=${shouldThread}`,
        );

        // The runtime may stream partials with reasoning/thinking tags
        // still embedded; we display text only. Reasoning previews are
        // their own lane (`onReasoningStream`) that we do NOT wire — the
        // bot surfaces the final assistant text, not its chain-of-thought.
        const onPartialReply = (partial: { text?: string }) => {
          const text = partial.text;
          if (typeof text !== "string" || text.length === 0) return;
          draftStream.update(text);
          // Stop the typing indicator once the first preview lands.
          // Typing + an empty preview looks broken; typing + a growing
          // preview is redundant. (Q12 default.)
          typing?.stop(payload.room.id);
        };

        const work = (async () => {
          try {
            await processInboundMessage(payload, {
              runtime,
              cfg: config,
              account,
              onPartialReply,
              deliver: async (replyPayload) => {
                const roomId = Number(replyPayload.to ?? payload.room.id);
                const text = replyPayload.text ?? replyPayload.body ?? "";

                // Streaming fast-path. Three cases:
                //
                //   (a) Stream is alive — route the final text through
                //       `update + stop`. The `stop()` implementation
                //       awaits the SDK loop's `inFlightPromise` before
                //       sending the final edit, so this is correct even
                //       when a partial's send is still pending and
                //       `messageId()` is momentarily undefined. The
                //       earlier gate `messageId() !== undefined`
                //       double-posted because it fell through to plain
                //       send while the in-flight partial was still
                //       writing its id. `isAlive()` gates on "can the
                //       loop still accept updates," which is what we
                //       need. For the threading-on case the in-flight
                //       send may be `firstSend` (creating the thread);
                //       `stop()` still awaits it correctly.
                //
                //   (b) Stream is dead but a preview exists — the SDK's
                //       controls wrapper silently drops further updates
                //       once stopped, so `update + stop` would no-op
                //       and leave the preview stuck on partial N-1.
                //       Bypass the loop and PATCH the final text
                //       directly via the client. The preview lives at
                //       `draftStream.roomId()` (which equals the thread
                //       room when `firstSend` already resolved, or the
                //       parent room otherwise). If even the direct edit
                //       fails, delete the stale preview and fall through.
                //
                //   (c) Stream is dead with no preview (first send
                //       failed, or no partials ever arrived) — fall
                //       through to a final fallback that honors the
                //       threading decision: `replyInThread` if we were
                //       supposed to thread, plain `sendMessage`
                //       otherwise. Without the `shouldThread` branch
                //       here, a thread-on conversation that hit a
                //       streaming failure would land in the parent room
                //       instead of being threaded.
                if (draftStream.isAlive()) {
                  draftStream.update(text);
                  await draftStream.stop();
                  return;
                }
                if (draftStream.messageId() !== undefined) {
                  const previewId = draftStream.messageId()!;
                  try {
                    await client.editMessage(previewId, text);
                    return;
                  } catch (err) {
                    logger?.error?.(
                      `${logPrefix} Draft stream recovery edit failed: ${formatStreamError(err)}`,
                    );
                    await client
                      .deleteMessage(previewId)
                      .catch(() => undefined);
                  }
                }

                if (shouldThread) {
                  await client.replyInThread(roomId, payload.message.id, text);
                  return;
                }
                await client.sendMessage(roomId, text);
              },
              logger,
            });
          } catch (err) {
            // Roll back the optimistic mark so a future reconnect
            // redelivery of this message_created event gets a fresh
            // attempt instead of being silently dropped as a duplicate.
            dedup.unmark(dedupKey!);
            // Q12 error-replace: replace the preview with the error
            // string so the user doesn't see a stuck partial. The
            // stream may already be `stopped` from the failure that
            // bubbled up here — going through `draftStream.update` /
            // `stop` would be a silent no-op in that case (the SDK
            // drops updates once stopped). Bypass the loop entirely
            // and PATCH via the client. `formatStreamError` redacts
            // bot keys from error messages before they land on a
            // public room message — `SabhaApiError` embeds the fetch
            // URL (which contains the bot key) in its message.
            //
            // Drain any in-flight partial send first so `messageId()`
            // is accurate. Without the flush, an error arriving while
            // a partial's send was pending would skip the error-replace
            // entirely (messageId undefined → gate fails), leave the
            // partial to land as a stale preview with no error
            // indication, and the user would see whatever the last
            // partial said instead of the error.
            await draftStream.flush().catch(() => undefined);
            if (draftStream.messageId() !== undefined) {
              const previewId = draftStream.messageId()!;
              const safe = formatStreamError(err);
              await client
                .editMessage(previewId, safe)
                .catch((replaceErr) => {
                  logger?.error?.(
                    `${logPrefix} Error-replace edit failed: ${formatStreamError(replaceErr)}`,
                  );
                });
            }
            logger?.error?.(`${logPrefix} Failed to process message ${payload.message.id}: ${formatStreamError(err)}`);
          } finally {
            // Draft stream cleanup: even on the success path, the SDK's
            // scheduled setTimeout is not unref'd. Explicitly stop the
            // loop so any pending tick is cleared and Node can exit
            // cleanly after an abort. Idempotent — calling stop on an
            // already-stopped loop is a no-op.
            await draftStream.stop().catch(() => undefined);
            typing?.stop(payload.room.id);
            inFlight.delete(dedupKey!);
          }
        })();
        inFlight.set(dedupKey!, work);
        return;
      }

      // Non-creation events: dedup, mark, dispatch. These handlers are
      // synchronous (log-only) today, so we mark dedup up-front and
      // don't need in-flight tracking. When Phase 2.2 upgrades the
      // boost handler to do async approval routing, move its dispatch
      // into the same optimistic-mark / rollback pattern used above.
      if (dedupKey) dedup.mark(dedupKey);
      statusSink?.({ lastInboundAt: Date.now() });

      try {
        switch (payload.event) {
          case "message_updated":
            await handleMessageUpdated(payload, { botId: account.botId, logger });
            break;
          case "message_deleted":
            await handleMessageDeleted(payload, { botId: account.botId, logger });
            break;
          case "boost_created":
            await handleBoostCreated(payload, { botId: account.botId, logger });
            break;
          case "boost_deleted":
            await handleBoostDeleted(payload, { botId: account.botId, logger });
            break;
          case "user_created":
            await handleUserCreated(payload, { logger });
            break;
          case "user_deleted":
            await handleUserDeleted(payload, { logger });
            break;
          default: {
            // Exhaustiveness check — unreachable if the webhook parser
            // rejects unknown events, which it does.
            const _exhaustive: never = payload;
            void _exhaustive;
          }
        }
      } catch (err) {
        if (dedupKey) dedup.unmark(dedupKey);
        logger?.error?.(`${logPrefix} Handler error for ${payload.event}: ${err}`);
      }
    },
  });

  // Tracks whether the reconnect loop exited because of a fatal,
  // unrecoverable error (auth failure, subscription rejected). On fatal
  // exits we park the hook until abort below so the SDK's account
  // supervisor doesn't auto-restart us into the same failure — reconnect
  // won't fix a wrong bot_key, it just spams the server and the logs.
  let fatalReason: string | null = null;
  try {
    await runWithReconnect(connectOnce, {
      abortSignal,
      jitterRatio: 0.2,
      shouldReconnect: ({ error }) => {
        // Server explicitly told us not to reconnect (auth failure, etc.)
        if (error instanceof DisconnectNoReconnectError) {
          fatalReason = error.message;
          return false;
        }
        // Subscription rejected — bot_key is invalid/unauthorized
        if (error instanceof SubscriptionRejectedError) {
          fatalReason = error.message;
          return false;
        }
        return true;
      },
      onError: (err) => {
        logger?.error?.(`${logPrefix} WebSocket connection failed: ${String(err)}`);
      },
      onReconnect: (delayMs) => {
        logger?.info?.(`${logPrefix} Reconnecting in ${Math.round(delayMs / 1000)}s`);
      },
    });

    if (fatalReason && !abortSignal?.aborted) {
      logger?.error?.(
        `${logPrefix} Fatal Sabha error (${fatalReason}) — parking this account until gateway restart. Fix the bot_key / apiBaseUrl and run \`openclaw gateway restart\`.`,
      );
      statusSink?.({ lastError: `fatal: ${fatalReason}` });
      await waitForAbort(abortSignal);
    }
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

