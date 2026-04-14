import {
  defineChannelPluginEntry,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { sabhaPlugin } from "./src/channel.js";
import { listEnabledBotAccounts, resolveBotAccount } from "./src/bot-accounts.js";
import { parseWebhookPayload } from "./src/webhook.js";
import {
  processInboundMessage,
  handleMessageUpdated,
  handleMessageDeleted,
  handleBoostCreated,
  handleBoostDeleted,
  handleUserCreated,
  handleUserDeleted,
} from "./src/inbound.js";
import { SabhaClient } from "./src/client.js";
import { createSabhaTools } from "./src/tools.js";
import { fetchSkillPrompt } from "./src/skill-prompt.js";
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
    const getConfig = () => api.runtime.config.loadConfig();

    // Register room/member management agent tools. Each entry is a
    // factory `(ctx) => tool` so the SDK can inject fresh agent context
    // (including `ctx.agentAccountId`) per invocation.
    const toolFactories = createSabhaTools(getConfig);
    for (const factory of toolFactories) {
      api.registerTool(factory);
    }

    // Fetch /skill on startup for every unique workspace across enabled
    // bot accounts. `/skill` renders per workspace (template interpolates
    // `Current.account.name` + `request.base_url`), so bot accounts sharing
    // a baseUrl share a cache entry while accounts on different workspaces
    // each get their own.
    const baseUrls = new Set<string>();
    for (const botAccount of listEnabledBotAccounts(getConfig())) {
      if (botAccount.baseUrl) baseUrls.add(botAccount.baseUrl);
    }
    for (const baseUrl of baseUrls) {
      fetchSkillPrompt(baseUrl).then((text) => {
        if (text) {
          api.logger.info?.(
            `[sabha] Loaded /skill prompt for ${baseUrl}`,
          );
        }
      });
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
          // bot webhook routing would need a path prefix scheme (e.g.
          // /sabha/webhook/:botAccountId) — deferred to v1.1.
          const cfg = getConfig();
          const currentAccount = resolveBotAccount({ cfg });

          // Mirror the monitor's dispatch table so every variant routes
          // to its typed handler. Only `message_created` runs the full
          // reply pipeline; the rest log via their typed stubs (Phase
          // 2.2 will upgrade `boost_created` to approval routing).
          if (payload.event === "message_created" && pluginRuntime) {
            const client = new SabhaClient(
              currentAccount.baseUrl,
              currentAccount.botKey,
            );

            // Streaming: non-thread replies get a draft stream that
            // `onPartialReply` feeds token-by-token. Thread replies
            // stay on the non-streaming path (see `monitor.ts` for the
            // same split). The webhook handler has to return 200
            // immediately, so we still `await processInboundMessage`
            // below — webhook mode is inherently sync-to-the-runtime.
            const threadContext = payload.message.thread;
            const streaming = threadContext == null;
            const draftStream = streaming
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
                // the thread. Only call replyInThread to CREATE a
                // thread from a top-level room message.
                const isInThread = payload.message.thread != null;

                if (replyPayload.replyToId && !isInThread) {
                  await client.replyInThread(
                    roomId,
                    Number(replyPayload.replyToId),
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
              // redacted error string so the bot_key embedded in
              // `SabhaApiError` URLs never lands in a public room
              // message.
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
