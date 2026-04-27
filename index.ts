import {
  defineChannelPluginEntry,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { sabhaPlugin } from "./src/channel.js";
import {
  listConfiguredSabhaAccountIds,
  resolveSabhaAccount,
} from "./src/accounts.js";
import { parseWebhookPayload } from "./src/webhook.js";
import {
  processInboundMessage,
  shouldStreamReply,
  handleMessageUpdated,
  handleMessageDeleted,
  handleBoostCreated,
  handleBoostDeleted,
  handleUserCreated,
  handleUserDeleted,
} from "./src/inbound.js";
import { SabhaClient } from "./src/client.js";
import { createSabhaTools } from "./src/tools.js";
import { createSabhaDraftStream, formatStreamError } from "./src/draft-stream.js";
let pluginRuntime: PluginRuntime | undefined;

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
  id: "sabha",
  name: "Sabha",
  description: "Connect OpenClaw to a Sabha chat server",
  plugin: sabhaPlugin,

  setRuntime(runtime: PluginRuntime) {
    pluginRuntime = runtime;
  },

  // CLI-only registration path: runs on `openclaw sabha …` without loading the
  // full plugin (gateway, services, webhook route, etc.)
  registerCliMetadata(api) {
    const getConfig = () => api.runtime.config.loadConfig();

    api.registerCli(
      async ({ program }) => {
        const { registerSabhaCli } = await import("./src/cli.js");
        registerSabhaCli({
          program,
          getConfig,
          writeConfigFile: (cfg) => api.runtime.config.writeConfigFile(cfg),
        });
      },
      {
        descriptors: [
          {
            name: "sabha",
            description: "Sabha channel commands",
            hasSubcommands: true,
          },
        ],
      },
    );
  },

  registerFull(api) {
    // Migration shim: fold any leftover base-level credentials (botKey,
    // baseUrl, etc.) sitting at `channels.sabha.<field>` into
    // `channels.sabha.accounts.default` so the multi-account resolver
    // can see them. SDK-blessed (matrix/setup-helpers); idempotent — a
    // config that's already in the canonical shape is unchanged.
    //
    // The set of keys actually moved is the union of the SDK's static
    // common set (`webhookSecret`, `dmPolicy`, `allowFrom`, …) and the
    // arrays declared on `sabhaPlugin.setup` — see
    // `src/setup-contract.ts` for the Sabha-specific creds list. Without
    // that contract, the shim is a no-op for `botKey` / `baseUrl` /
    // `apiBaseUrl`, which would defeat the whole point.
    //
    // Closes the silent-leak footgun where base-level creds would be
    // inherited into every named account that doesn't override them.
    const before = api.runtime.config.loadConfig();
    const migratedCfg = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: before,
      channelKey: "sabha",
    });
    if (migratedCfg !== before) {
      api.logger.info?.(
        "[sabha] Migrated base-level credentials into channels.sabha.accounts.default",
      );
      // Fire-and-forget persistence. We don't await because `registerFull`
      // is invoked synchronously by the SDK loader (no await), so blocking
      // here can't actually delay gateway startup — and the in-process
      // checks below use `migratedCfg` directly instead of round-tripping
      // through `loadConfig()`, so they don't depend on the write
      // completing. If the write fails (read-only mount?) the operator
      // sees the error in logs; the resolver's base→default layering
      // means runtime behavior is correct from either shape.
      void api.runtime.config.writeConfigFile(migratedCfg).catch((err) => {
        api.logger.error?.(
          `[sabha] Failed to persist migrated config: ${err}`,
        );
      });
    }

    const getConfig = () => api.runtime.config.loadConfig();

    // Detect the silent-skip case: `channels.sabha` is set (operator thinks
    // sabha is configured) but no explicit `accounts` entries exist and the
    // base block has no credentials either. The SDK's listAccountIds returns
    // ["default"] as a fallback, so we can't use that for the warning;
    // listConfiguredSabhaAccountIds returns the truly-configured set.
    //
    // Uses `migratedCfg` (the in-memory post-migration shape) rather than
    // re-reading via `loadConfig()` so we don't race the on-disk write.
    if (
      migratedCfg.channels?.sabha &&
      listConfiguredSabhaAccountIds(migratedCfg).length === 0 &&
      !resolveSabhaAccount({ cfg: migratedCfg }).botKey
    ) {
      api.logger.warn(
        "[sabha] channels.sabha is set but has no accounts entries and no base-level botKey — " +
          "no Sabha bot will start. Add credentials under accounts.<id> " +
          "(e.g. accounts.default) or run `openclaw configure --section channels`. " +
          "See https://github.com/sabha-co/openclaw-sabha#configure for the correct shape.",
      );
    }

    // Register room/member management agent tools. Each entry is a
    // factory `(ctx) => tool` so the SDK can inject fresh agent context
    // (including `ctx.agentAccountId`) per invocation.
    const toolFactories = createSabhaTools(getConfig);
    for (const factory of toolFactories) {
      api.registerTool(factory);
    }

    // Inbound webhook handler (fallback for connectionMode: "webhook")
    api.registerHttpRoute({
      path: "/sabha/webhook",
      auth: "plugin",
      handler: async (req, res) => {
        const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

        try {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of req) {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            totalBytes += buf.length;
            if (totalBytes > MAX_BODY_BYTES) {
              res.statusCode = 413;
              res.end("Payload Too Large");
              return true;
            }
            chunks.push(buf);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const payload = parseWebhookPayload(body);

          // Webhook mode binds to one HTTP route per plugin, so we route
          // every inbound event through the default bot account. Multi-
          // account webhook routing would need a path prefix scheme (e.g.
          // /sabha/webhook/:accountId) — deferred to v1.1.
          const cfg = getConfig();
          const currentAccount = resolveSabhaAccount({ cfg });

          // Mirror the monitor's dispatch table so every variant routes
          // to its typed handler. Only `message_created` runs the full
          // reply pipeline; the rest log via their typed stubs (Phase
          // 2.2 will upgrade `boost_created` to approval routing).
          if (payload.event === "message_created" && pluginRuntime) {
            const client = new SabhaClient(
              currentAccount.apiBaseUrl,
              currentAccount.botKey,
            );

            // Streaming: gate is centralized in `shouldStreamReply` so the
            // webhook path uses the same rules as the WS monitor. Covers
            // in-thread, DM, and threading-off cases. Top-level non-DM
            // with threading on still skips streaming (Phase 2 will add a
            // `firstSend` hook so partials can land in the new thread
            // instead of orphaned in the parent room). The webhook handler
            // has to return 200 immediately, so we still `await
            // processInboundMessage` below — webhook mode is inherently
            // sync-to-the-runtime.
            const draftStream = shouldStreamReply(payload, currentAccount)
              ? createSabhaDraftStream({
                  client,
                  roomId: payload.room.id,
                  logger: {
                    debug: (msg) => api.logger.info?.(`[sabha] ${msg}`),
                    warn: (msg) => api.logger.error?.(`[sabha] ${msg}`),
                  },
                })
              : undefined;
            const onPartialReply = draftStream
              ? (partial: { text?: string }) => {
                  const text = partial.text;
                  if (typeof text !== "string" || text.length === 0) return;
                  draftStream.update(text);
                }
              : undefined;

            try {
              await processInboundMessage(payload, {
              runtime: pluginRuntime,
              cfg,
              account: currentAccount,
              logger: api.logger,
              ...(onPartialReply ? { onPartialReply } : {}),
              deliver: async (replyPayload) => {
                const roomId = Number(
                  replyPayload.to ?? payload.room.id,
                );
                const text = replyPayload.text ?? replyPayload.body ?? "";
                // Sabha threads are Room subclasses; when the inbound
                // is already in a thread, plain sendMessage posts into
                // the thread. See monitor.ts for the full rationale on
                // why we resolve replyToMode ourselves.
                const isInThread = payload.message.thread != null;
                const isDm = payload.room.type === "Direct";
                const replyToMode = currentAccount.replyToMode ?? "first";
                const shouldThread = !isInThread && !isDm && replyToMode !== "off";

                if (shouldThread) {
                  await client.replyInThread(
                    roomId,
                    payload.message.id,
                    text,
                  );
                  return;
                }

                // Streaming fast-path — see monitor.ts for the full
                // rationale. Three cases: (a) stream is alive → route
                // through update + stop which drains any in-flight
                // partial send; (b) stream is dead but preview exists
                // → bypass the SDK and PATCH directly; (c) stream is
                // dead with no preview → plain send.
                if (draftStream && draftStream.isAlive()) {
                  draftStream.update(text);
                  await draftStream.stop();
                  return;
                }
                if (draftStream && draftStream.messageId() !== undefined) {
                  const previewId = draftStream.messageId()!;
                  try {
                    await client.editMessage(roomId, previewId, text);
                    return;
                  } catch (err) {
                    api.logger.error?.(
                      `[sabha] Draft stream recovery edit failed: ${formatStreamError(err)}`,
                    );
                    await client
                      .deleteMessage(roomId, previewId)
                      .catch(() => undefined);
                  }
                }

                await client.sendMessage(roomId, text);
              },
            });
            } catch (err) {
              // Q12 error-replace (webhook path). Mirrors monitor.ts:
              // drain in-flight partial sends first so messageId() is
              // accurate, then bypass the draft stream (it may be
              // stopped) and PATCH the preview directly with a
              // redacted error string. Since the bearer-auth refactor
              // the bot_key is no longer embedded in the URL (it rides
              // in the Authorization header), but the redactor stays
              // as defense-in-depth for any future leak path.
              if (draftStream) {
                await draftStream.flush().catch(() => undefined);
              }
              if (draftStream && draftStream.messageId() !== undefined) {
                const previewId = draftStream.messageId()!;
                const safe = formatStreamError(err);
                await client
                  .editMessage(payload.room.id, previewId, safe)
                  .catch((replaceErr) => {
                    api.logger.error?.(
                      `[sabha] Webhook error-replace edit failed: ${formatStreamError(replaceErr)}`,
                    );
                  });
              }
              api.logger.error?.(
                `[sabha] Webhook dispatch failed: ${formatStreamError(err)}`,
              );
            } finally {
              // Clear the SDK's pending setTimeout so the Node event
              // loop can unwind after the request handler returns.
              if (draftStream) {
                await draftStream.stop().catch(() => undefined);
              }
            }
          } else {
            const botId = currentAccount.botId;
            switch (payload.event) {
              case "message_updated":
                await handleMessageUpdated(payload, { botId, logger: api.logger });
                break;
              case "message_deleted":
                await handleMessageDeleted(payload, { botId, logger: api.logger });
                break;
              case "boost_created":
                await handleBoostCreated(payload, { botId, logger: api.logger });
                break;
              case "boost_deleted":
                await handleBoostDeleted(payload, { botId, logger: api.logger });
                break;
              case "user_created":
                await handleUserCreated(payload, { logger: api.logger });
                break;
              case "user_deleted":
                await handleUserDeleted(payload, { logger: api.logger });
                break;
              case "message_created":
                // Runtime not ready yet — drop silently. This branch
                // only fires when `pluginRuntime` is undefined (before
                // setRuntime has been called). Rare in practice.
                break;
              default: {
                // Exhaustiveness check. If v1.1 adds a new event type
                // and this branch fails to compile, extend the switch
                // above so webhook mode stays in lock-step with the
                // monitor's dispatch table.
                const _exhaustive: never = payload;
                void _exhaustive;
              }
            }
          }

          res.statusCode = 200;
          res.end();
          return true;
        } catch (err) {
          api.logger.error?.(`[sabha] Webhook error: ${err}`);
          res.statusCode = 400;
          res.end("Bad Request");
          return true;
        }
      },
    });
  },
});

export default entry;
